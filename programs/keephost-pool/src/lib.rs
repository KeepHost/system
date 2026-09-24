//! KeepHost — non-custodial pool on Solana.
//!
//! Deposits are held by a vault PDA: an address with no private key. The only
//! instruction that moves funds is `withdraw`, and it requires a valid
//! zero-knowledge proof. There is no administrator withdrawal instruction, no
//! transfer of authority over the vault, and no path to close it.
//! `set_paused` can only stop new deposits; it cannot block a withdrawal or
//! touch the funds.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::solana_program::rent::Rent as SolRent;
use anchor_lang::solana_program::system_instruction;
use groth16_solana::groth16::Groth16Verifier;
pub mod spl;
use spl::TOKEN_PROGRAM_ID;
use solana_poseidon::{hashv, Endianness, Parameters};

pub mod verifying_key;
use verifying_key::VERIFYINGKEY;

pub mod zeros;
use zeros::ZEROS;

declare_id!("CTHg29kf7L6TNDH5TSd3tdoZfsmP39JjyQWKmPtEY1YW");

pub const LEVELS: usize = 20;
pub const ROOT_HISTORY: usize = 32;
pub const PUBLIC_INPUTS: usize = 9;
/// Deposit fee, in hundredths of a percent: 50 = 0.5% of the denomination.
/// Charged on top of the deposit, never taken out of it — the vault must hold
/// exactly one denomination per deposit or a withdrawal cannot pay out.
pub const FEE_BPS: u64 = 50;
/// The KEEPHOST mint. Burning from it is the only way to mint a key, and the
/// address is fixed here so no other token can be passed in its place.
pub const KEEPHOST_MINT: Pubkey = pubkey!("4c1XZRqFV6y8pAckHru5oiGPYUFw1eQ3kFotPLHrpump");
/// Tokens to burn for one key, in base units (6 decimals): 1,000,000 tokens.
pub const KEY_BURN: u64 = 1_000_000_000_000;

pub const FIELD_MODULUS: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
    0x28, 0x33, 0xe8, 0x48, 0x79, 0xb9, 0x70, 0x91, 0x43, 0xe1, 0xf5, 0x93, 0xf0, 0x00, 0x00, 0x01,
];

#[program]
pub mod keephost_pool {
    use super::*;

    /// Opens a pool for a fixed denomination (in lamports) and funds the vault
    /// up to the rent-exempt minimum.
    pub fn initialize(ctx: Context<Initialize>, denomination: u64, pause_authority: Option<Pubkey>) -> Result<()> {
        let rent_min = SolRent::get()?.minimum_balance(0);
        require!(denomination >= rent_min, PoolError::BadDenomination);

        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.creator.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                },
            ),
            rent_min,
        )?;

        let pool = &mut ctx.accounts.pool.load_init()?;
        pool.bump = ctx.bumps.pool;
        pool.vault_bump = ctx.bumps.vault;
        pool.creator = ctx.accounts.creator.key();
        pool.denomination = denomination;
        pool.vault_floor = rent_min;
        pool.next_index = 0;
        pool.current_root_index = 0;
        pool.deposits = 0;
        pool.paused = 0;
        pool.pause_authority = pause_authority.unwrap_or_default();
        for i in 0..LEVELS {
            pool.filled_subtrees[i] = ZEROS[i];
        }
        // Every root slot starts at the empty-tree root, so a zero root can
        // never pass for a known one.
        for i in 0..ROOT_HISTORY {
            pool.roots[i] = ZEROS[LEVELS];
        }

        emit!(PoolOpened {
            pool: ctx.accounts.pool.key(),
            creator: pool.creator,
            denomination,
        });
        Ok(())
    }

    /// Deposits the exact denomination and records the commitment in the tree.
    pub fn deposit(ctx: Context<Deposit>, commitment: [u8; 32]) -> Result<()> {
        let denomination = {
            let pool = ctx.accounts.pool.load()?;
            require!(pool.paused == 0, PoolError::Paused);
            require!(is_field_element(&commitment), PoolError::NotFieldElement);
            require!(commitment != [0u8; 32], PoolError::NotFieldElement);
            require!((pool.next_index as usize) < (1usize << LEVELS), PoolError::TreeFull);
            pool.denomination
        };

        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.depositor.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                },
            ),
            denomination,
        )?;

        // The fee is charged on top and goes to its own account, never into the
        // vault: the vault must hold exactly one denomination per deposit, or
        // the last withdrawal cannot be paid. A key belonging to this depositor
        // exempts them — that is what burning tokens buys, and the only thing
        // it buys.
        let exempt = match &ctx.accounts.key {
            Some(key) => key.owner == ctx.accounts.depositor.key(),
            None => false,
        };
        let fee = if exempt { 0 } else { denomination / 10_000 * FEE_BPS };
        if fee > 0 {
            // Solana refuses to leave an account below the rent-exempt minimum,
            // and one deposit fee is smaller than that minimum. So the first
            // deposit after this account is empty also pays what it takes to
            // bring it up — once, never again, and it stays in the account
            // rather than going anywhere.
            let rent_min = SolRent::get()?.minimum_balance(0);
            let have = ctx.accounts.fees.lamports();
            let top_up = rent_min.saturating_sub(have.saturating_add(fee));
            anchor_lang::system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    anchor_lang::system_program::Transfer {
                        from: ctx.accounts.depositor.to_account_info(),
                        to: ctx.accounts.fees.to_account_info(),
                    },
                ),
                fee.saturating_add(top_up),
            )?;
        }

        let pool = &mut ctx.accounts.pool.load_mut()?;
        let leaf_index = pool.next_index;
        let root = insert_leaf(pool, commitment)?;
        pool.next_index = leaf_index + 1;
        pool.deposits = pool.deposits.saturating_add(1);
        let slot = (pool.current_root_index as usize + 1) % ROOT_HISTORY;
        pool.current_root_index = slot as u8;
        pool.roots[slot] = root;

        emit!(Deposited {
            pool: ctx.accounts.pool.key(),
            commitment,
            leaf_index,
            root,
            at: Clock::get()?.unix_timestamp,
        });
        Ok(())
    }

    /// Opens a pool for one SPL token at one fixed amount. The creator is part
    /// of the seeds, so nobody can take a denomination hostage, and the vault is
    /// a token account owned by a PDA — an address with no private key.
    pub fn initialize_token_pool(ctx: Context<InitializeTokenPool>, denomination: u64) -> Result<()> {
        require!(denomination > 0, PoolError::BadDenomination);

        // The vault token account, created by hand so the binary does not carry
        // the Token-2022 surface it would otherwise need. Same result: an
        // account of the token program, for this mint, owned by a PDA.
        let pool_key = ctx.accounts.pool.key();
        let vault_seeds: &[&[u8]] = &[
            b"token-vault-account",
            pool_key.as_ref(),
            &[ctx.bumps.vault],
        ];
        // A token account is 165 bytes. The constant is the token program's,
        // not ours, and it has never changed.
        let space = 165usize;
        let lamports = SolRent::get()?.minimum_balance(space);
        anchor_lang::system_program::create_account(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::CreateAccount {
                    from: ctx.accounts.creator.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                },
                &[vault_seeds],
            ),
            lamports,
            space as u64,
            &ctx.accounts.token_program.key(),
        )?;
        spl::initialize_account3(
            &ctx.accounts.token_program,
            &ctx.accounts.vault,
            &ctx.accounts.mint,
            &ctx.accounts.vault_authority.key(),
        )?;

        let pool = &mut ctx.accounts.pool.load_init()?;
        pool.creator = ctx.accounts.creator.key();
        pool.mint = ctx.accounts.mint.key();
        pool.denomination = denomination;
        pool.deposits = 0;
        pool.next_index = 0;
        pool.bump = ctx.bumps.pool;
        // The bump stored is the one of the PDA that OWNS the vault, not of the
        // token account: it is the authority PDA this program signs with.
        pool.vault_bump = ctx.bumps.vault_authority;
        pool.paused = 0;
        pool.current_root_index = 0;
        pool.filled_subtrees = ZEROS[..LEVELS].try_into().unwrap();
        pool.roots = [ZEROS[LEVELS]; ROOT_HISTORY];

        emit!(TokenPoolOpened {
            pool: ctx.accounts.pool.key(),
            mint: pool.mint,
            denomination,
        });
        Ok(())
    }

    /// Deposits exactly the denomination of the pool's token and writes the
    /// commitment into the tree. The chain sees the amount and the depositor,
    /// as it does for SOL; it never sees which withdrawal they will make.
    pub fn deposit_token(ctx: Context<DepositToken>, commitment: [u8; 32]) -> Result<()> {
        let denomination = {
            let pool = ctx.accounts.pool.load()?;
            require!(pool.paused == 0, PoolError::Paused);
            require!(is_field_element(&commitment), PoolError::NotFieldElement);
            require!(commitment != [0u8; 32], PoolError::NotFieldElement);
            require!((pool.next_index as usize) < (1usize << LEVELS), PoolError::TreeFull);
            pool.denomination
        };

        let (from_mint, from_owner) = spl::read_token_account(&ctx.accounts.from)?;
        let (vault_mint, _) = spl::read_token_account(&ctx.accounts.vault)?;
        require_keys_eq!(from_mint, vault_mint, PoolError::WrongMint);
        require_keys_eq!(from_owner, ctx.accounts.depositor.key(), PoolError::WrongMint);
        spl::transfer(
            &ctx.accounts.token_program,
            &ctx.accounts.from,
            &ctx.accounts.vault,
            &ctx.accounts.depositor,
            denomination,
            None,
        )?;

        let pool = &mut ctx.accounts.pool.load_mut()?;
        let leaf_index = pool.next_index;
        let root = append_leaf(&mut pool.filled_subtrees, leaf_index, commitment)?;
        pool.next_index = leaf_index + 1;
        pool.deposits = pool.deposits.saturating_add(1);
        let slot = (pool.current_root_index as usize + 1) % ROOT_HISTORY;
        pool.current_root_index = slot as u8;
        pool.roots[slot] = root;

        emit!(Deposited {
            pool: ctx.accounts.pool.key(),
            commitment,
            leaf_index,
            root,
            at: Clock::get()?.unix_timestamp,
        });
        Ok(())
    }

    /// Burns KEEPHOST tokens and mints a key: from then on, this wallet pays no
    /// deposit fee, for good. The tokens are destroyed by the token program —
    /// they do not come to us, and nothing here can give them back.
    pub fn burn_for_key(ctx: Context<BurnForKey>, amount: u64) -> Result<()> {
        require!(amount >= KEY_BURN, PoolError::BurnTooSmall);

        let (mint, owner) = spl::read_token_account(&ctx.accounts.from)?;
        require_keys_eq!(mint, KEEPHOST_MINT, PoolError::WrongMint);
        require_keys_eq!(owner, ctx.accounts.owner.key(), PoolError::WrongMint);
        spl::burn(
            &ctx.accounts.token_program,
            &ctx.accounts.mint,
            &ctx.accounts.from,
            &ctx.accounts.owner,
            amount,
        )?;

        let key = &mut ctx.accounts.key;
        key.owner = ctx.accounts.owner.key();
        key.burned = amount;
        key.at = Clock::get()?.unix_timestamp;
        key.bump = ctx.bumps.key;

        emit!(KeyMinted { owner: key.owner, burned: amount, at: key.at });
        Ok(())
    }

    /// Withdraws the denomination to `recipient`, on proof that the caller knows
    /// the secret of a deposit in the tree. `fee` is paid to the relayer.
    pub fn withdraw<'info>(
        ctx: Context<'_, '_, '_, 'info, Withdraw<'info>>,
        proof_a: [u8; 64],
        proof_b: [u8; 128],
        proof_c: [u8; 64],
        root: [u8; 32],
        nullifier_hash: [u8; 32],
        fee: u64,
    ) -> Result<()> {
        let pool_key = ctx.accounts.pool.key();
        let (denomination, vault_bump) = {
            let pool = ctx.accounts.pool.load()?;
            require!(fee < pool.denomination, PoolError::FeeTooHigh);
            require!(root != [0u8; 32], PoolError::UnknownRoot);
            require!(is_field_element(&root) && is_field_element(&nullifier_hash), PoolError::NotFieldElement);
            require!(pool.roots.contains(&root), PoolError::UnknownRoot);
            (pool.denomination, pool.vault_bump)
        };

        // The nullifier account is created with `init`: if it already exists
        // the instruction fails, so a deposit cannot be withdrawn twice.
        let nullifier = &mut ctx.accounts.nullifier;
        nullifier.pool = pool_key;
        nullifier.hash = nullifier_hash;

        let (recipient_hi, recipient_lo) = split(&ctx.accounts.recipient.key().to_bytes());
        let (relayer_hi, relayer_lo) = split(&ctx.accounts.relayer.key().to_bytes());
        let (pool_hi, pool_lo) = split(&pool_key.to_bytes());
        let mut fee_field = [0u8; 32];
        fee_field[24..].copy_from_slice(&fee.to_be_bytes());

        let public_inputs: [[u8; 32]; PUBLIC_INPUTS] = [
            root,
            nullifier_hash,
            recipient_hi,
            recipient_lo,
            relayer_hi,
            relayer_lo,
            fee_field,
            pool_hi,
            pool_lo,
        ];
        let mut verifier = Groth16Verifier::new(&proof_a, &proof_b, &proof_c, &public_inputs, &VERIFYINGKEY)
            .map_err(|_| error!(PoolError::BadProof))?;
        verifier.verify().map_err(|_| error!(PoolError::BadProof))?;

        // The relayer's fee is paid out of the deposit fees when there are
        // enough, and out of the withdrawal only when there are not. That is
        // what the fee account is for: deposits make withdrawals free, and the
        // person withdrawing gets the whole denomination.
        let rent_min = SolRent::get()?.minimum_balance(0);
        let pot = ctx.accounts.fees.lamports();
        let from_pot = fee > 0 && pot >= fee.saturating_add(rent_min);

        let seeds: &[&[u8]] = &[b"vault", pool_key.as_ref(), &[vault_bump]];
        let to_recipient = if from_pot { denomination } else { denomination - fee };
        pay_from_vault(&ctx, seeds, &ctx.accounts.recipient.to_account_info(), to_recipient)?;

        if fee > 0 {
            if from_pot {
                let fee_seeds: &[&[u8]] = &[b"fees", pool_key.as_ref(), &[ctx.bumps.fees]];
                invoke_signed(
                    &system_instruction::transfer(
                        &ctx.accounts.fees.key(),
                        &ctx.accounts.relayer.key(),
                        fee,
                    ),
                    &[
                        ctx.accounts.fees.to_account_info(),
                        ctx.accounts.relayer.to_account_info(),
                        ctx.accounts.system_program.to_account_info(),
                    ],
                    &[fee_seeds],
                )?;
            } else {
                pay_from_vault(&ctx, seeds, &ctx.accounts.relayer.to_account_info(), fee)?;
            }
        }

        emit!(Withdrawn {
            pool: pool_key,
            nullifier_hash,
            recipient: ctx.accounts.recipient.key(),
            relayer: ctx.accounts.relayer.key(),
            fee,
            at: Clock::get()?.unix_timestamp,
        });
        Ok(())
    }

    /// Stops or resumes new deposits. Withdrawals stay possible while paused.
    /// Withdraws the pool's token to `recipient`, on the same proof as a SOL
    /// withdrawal: the recipient, the relayer, the fee and the pool are all
    /// public inputs, so a relayer can forward this or refuse it, nothing else.
    ///
    /// `recipient` and `relayer` here are token accounts, and the proof binds
    /// those addresses — paying a different account invalidates it.
    pub fn withdraw_token(
        ctx: Context<WithdrawToken>,
        proof_a: [u8; 64],
        proof_b: [u8; 128],
        proof_c: [u8; 64],
        root: [u8; 32],
        nullifier_hash: [u8; 32],
        fee: u64,
    ) -> Result<()> {
        let pool_key = ctx.accounts.pool.key();
        let (denomination, vault_bump, mint) = {
            let pool = ctx.accounts.pool.load()?;
            require!(fee < pool.denomination, PoolError::FeeTooHigh);
            require!(root != [0u8; 32], PoolError::UnknownRoot);
            require!(
                is_field_element(&root) && is_field_element(&nullifier_hash),
                PoolError::NotFieldElement
            );
            require!(pool.roots.contains(&root), PoolError::UnknownRoot);
            (pool.denomination, pool.vault_bump, pool.mint)
        };
        // Paying in a different token than the pool holds would let a pool be
        // drained through a vault someone else controls.
        let (recipient_mint, _) = spl::read_token_account(&ctx.accounts.recipient)?;
        let (relayer_mint, _) = spl::read_token_account(&ctx.accounts.relayer_account)?;
        require_keys_eq!(recipient_mint, mint, PoolError::WrongMint);
        require_keys_eq!(relayer_mint, mint, PoolError::WrongMint);

        let nullifier = &mut ctx.accounts.nullifier;
        nullifier.pool = pool_key;
        nullifier.hash = nullifier_hash;

        let (recipient_hi, recipient_lo) = split(&ctx.accounts.recipient.key().to_bytes());
        let (relayer_hi, relayer_lo) = split(&ctx.accounts.relayer_account.key().to_bytes());
        let (pool_hi, pool_lo) = split(&pool_key.to_bytes());
        let mut fee_field = [0u8; 32];
        fee_field[24..].copy_from_slice(&fee.to_be_bytes());

        let public_inputs: [[u8; 32]; PUBLIC_INPUTS] = [
            root,
            nullifier_hash,
            recipient_hi,
            recipient_lo,
            relayer_hi,
            relayer_lo,
            fee_field,
            pool_hi,
            pool_lo,
        ];
        let mut verifier = Groth16Verifier::new(&proof_a, &proof_b, &proof_c, &public_inputs, &VERIFYINGKEY)
            .map_err(|_| error!(PoolError::BadProof))?;
        verifier.verify().map_err(|_| error!(PoolError::BadProof))?;

        let seeds: &[&[u8]] = &[b"token-vault", pool_key.as_ref(), &[vault_bump]];
        let signer: &[&[&[u8]]] = &[seeds];

        spl::transfer(
            &ctx.accounts.token_program,
            &ctx.accounts.vault,
            &ctx.accounts.recipient,
            &ctx.accounts.vault_authority,
            denomination - fee,
            Some(signer),
        )?;

        if fee > 0 {
            spl::transfer(
                &ctx.accounts.token_program,
                &ctx.accounts.vault,
                &ctx.accounts.relayer_account,
                &ctx.accounts.vault_authority,
                fee,
                Some(signer),
            )?;
        }

        emit!(Withdrawn {
            pool: pool_key,
            nullifier_hash,
            recipient: ctx.accounts.recipient.key(),
            relayer: ctx.accounts.relayer_account.key(),
            fee,
            at: Clock::get()?.unix_timestamp,
        });
        Ok(())
    }

    pub fn set_paused(ctx: Context<SetPaused>, paused: bool) -> Result<()> {
        let pool = &mut ctx.accounts.pool.load_mut()?;
        require!(pool.pause_authority != Pubkey::default(), PoolError::NoPauseAuthority);
        require_keys_eq!(pool.pause_authority, ctx.accounts.authority.key(), PoolError::NotPauseAuthority);
        pool.paused = u8::from(paused);
        emit!(PauseChanged { pool: ctx.accounts.pool.key(), paused });
        Ok(())
    }

    /// Gives up the pause authority permanently.
    pub fn renounce_pause(ctx: Context<SetPaused>) -> Result<()> {
        let pool = &mut ctx.accounts.pool.load_mut()?;
        require!(pool.pause_authority != Pubkey::default(), PoolError::NoPauseAuthority);
        require_keys_eq!(pool.pause_authority, ctx.accounts.authority.key(), PoolError::NotPauseAuthority);
        pool.pause_authority = Pubkey::default();
        pool.paused = 0;
        emit!(PauseRenounced { pool: ctx.accounts.pool.key() });
        Ok(())
    }
}

fn pay_from_vault<'info>(
    ctx: &Context<'_, '_, '_, 'info, Withdraw<'info>>,
    seeds: &[&[u8]],
    to: &AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    invoke_signed(
        &system_instruction::transfer(&ctx.accounts.vault.key(), &to.key(), amount),
        &[
            ctx.accounts.vault.to_account_info(),
            to.clone(),
            ctx.accounts.system_program.to_account_info(),
        ],
        &[seeds],
    )?;
    Ok(())
}

/// Appends a leaf to an incremental tree and returns the new root. Takes the
/// tree's own fields rather than the account, so a SOL pool and a token pool
/// share one implementation — two copies of this would be two chances to
/// diverge, and a divergence here is a proof that no longer verifies.
fn append_leaf(
    filled_subtrees: &mut [[u8; 32]; LEVELS],
    next_index: u32,
    leaf: [u8; 32],
) -> Result<[u8; 32]> {
    let mut index = next_index as usize;
    let mut current = leaf;
    for level in 0..LEVELS {
        let (left, right) = if index % 2 == 0 {
            filled_subtrees[level] = current;
            (current, ZEROS[level])
        } else {
            (filled_subtrees[level], current)
        };
        current = poseidon2(&left, &right)?;
        index /= 2;
    }
    Ok(current)
}

fn insert_leaf(pool: &mut Pool, leaf: [u8; 32]) -> Result<[u8; 32]> {
    let next = pool.next_index;
    append_leaf(&mut pool.filled_subtrees, next, leaf)
}

fn poseidon2(left: &[u8; 32], right: &[u8; 32]) -> Result<[u8; 32]> {
    let h = hashv(Parameters::Bn254X5, Endianness::BigEndian, &[left, right])
        .map_err(|_| error!(PoolError::HashFailed))?;
    Ok(h.to_bytes())
}

fn is_field_element(value: &[u8; 32]) -> bool {
    for i in 0..32 {
        if value[i] < FIELD_MODULUS[i] {
            return true;
        }
        if value[i] > FIELD_MODULUS[i] {
            return false;
        }
    }
    false
}

/// Two 16-byte halves keep the encoding injective. In one piece an address
/// reduces modulo p, letting a relayer redirect a withdrawal to a twin address.
fn split(bytes: &[u8; 32]) -> ([u8; 32], [u8; 32]) {
    let mut hi = [0u8; 32];
    let mut lo = [0u8; 32];
    hi[16..].copy_from_slice(&bytes[..16]);
    lo[16..].copy_from_slice(&bytes[16..]);
    (hi, lo)
}

#[account(zero_copy)]
#[repr(C)]
pub struct Pool {
    pub creator: Pubkey,
    pub pause_authority: Pubkey,
    pub denomination: u64,
    pub vault_floor: u64,
    pub deposits: u64,
    pub next_index: u32,
    pub bump: u8,
    pub vault_bump: u8,
    pub paused: u8,
    pub current_root_index: u8,
    pub filled_subtrees: [[u8; 32]; LEVELS],
    pub roots: [[u8; 32]; ROOT_HISTORY],
}

/// A pool holding an SPL token instead of lamports. Same tree, same proof, same
/// relayer — the only difference is what the vault holds. It is a separate
/// account type on purpose: the SOL pools are live with deposits inside them,
/// and changing their layout would make those deposits unreadable.
#[account(zero_copy)]
#[repr(C)]
pub struct TokenPool {
    pub creator: Pubkey,
    pub mint: Pubkey,
    pub denomination: u64,
    pub deposits: u64,
    pub next_index: u32,
    pub bump: u8,
    pub vault_bump: u8,
    pub paused: u8,
    pub current_root_index: u8,
    pub filled_subtrees: [[u8; 32]; LEVELS],
    pub roots: [[u8; 32]; ROOT_HISTORY],
}

impl TokenPool {
    pub const SIZE: usize = 8 + core::mem::size_of::<TokenPool>();
}

impl Pool {
    pub const SIZE: usize = 8 + core::mem::size_of::<Pool>();
}

#[account]
pub struct Nullifier {
    pub pool: Pubkey,
    pub hash: [u8; 32],
}

impl Nullifier {
    pub const SIZE: usize = 8 + 32 + 32;
}

#[derive(Accounts)]
#[instruction(denomination: u64)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    /// The creator is part of the seeds, so nobody can front-run a denomination
    /// to claim the pause authority of a pool that is not theirs.
    #[account(
        init,
        payer = creator,
        space = Pool::SIZE,
        seeds = [b"pool", creator.key().as_ref(), denomination.to_le_bytes().as_ref()],
        bump
    )]
    pub pool: AccountLoader<'info, Pool>,
    /// CHECK: vault PDA, checked by its seeds; holds lamports only.
    #[account(mut, seeds = [b"vault", pool.key().as_ref()], bump)]
    pub vault: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,
    #[account(mut)]
    pub pool: AccountLoader<'info, Pool>,
    /// CHECK: vault PDA, checked by its seeds.
    #[account(mut, seeds = [b"vault", pool.key().as_ref()], bump)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: fee PDA, checked by its seeds. Holds lamports and nothing else.
    #[account(mut, seeds = [b"fees", pool.key().as_ref()], bump)]
    pub fees: UncheckedAccount<'info>,
    /// The depositor's key, if they have one. Its seeds tie it to a wallet, so
    /// passing someone else's changes nothing: the fee is waived only when the
    /// key belongs to the signer.
    #[account(seeds = [b"key", key.owner.as_ref()], bump = key.bump)]
    pub key: Option<Account<'info, BurnKey>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(denomination: u64)]
pub struct InitializeTokenPool<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(
        init,
        payer = creator,
        space = TokenPool::SIZE,
        seeds = [b"token-pool", creator.key().as_ref(), mint.key().as_ref(), denomination.to_le_bytes().as_ref()],
        bump
    )]
    pub pool: AccountLoader<'info, TokenPool>,
    /// CHECK: the mint this pool accepts. The token program checks it when the
    /// vault is created against it.
    pub mint: UncheckedAccount<'info>,
    /// The vault is a token account whose authority is a PDA: no human can
    /// sign for it, and the only code that can move it is this program.
    ///
    /// CHECK: created here by CPI rather than by Anchor's `init`. The `init`
    /// form drags the whole Token-2022 surface into the binary — 160 kB that
    /// would have to be paid for in rent, for a constraint we enforce by hand
    /// three lines below.
    #[account(mut, seeds = [b"token-vault-account", pool.key().as_ref()], bump)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: PDA that owns the vault, checked by its seeds. Holds no data.
    #[account(seeds = [b"token-vault", pool.key().as_ref()], bump)]
    pub vault_authority: UncheckedAccount<'info>,
    /// CHECK: the SPL token program, pinned by address.
    #[account(address = TOKEN_PROGRAM_ID)]
    pub token_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DepositToken<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,
    #[account(mut)]
    pub pool: AccountLoader<'info, TokenPool>,
    /// CHECK: the pool's token account, checked by its seeds and read by hand.
    #[account(mut, seeds = [b"token-vault-account", pool.key().as_ref()], bump)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: the depositor's token account; its mint and owner are checked.
    #[account(mut)]
    pub from: UncheckedAccount<'info>,
    /// CHECK: the SPL token program, pinned by address.
    #[account(address = TOKEN_PROGRAM_ID)]
    pub token_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(proof_a: [u8; 64], proof_b: [u8; 128], proof_c: [u8; 64], root: [u8; 32], nullifier_hash: [u8; 32])]
pub struct WithdrawToken<'info> {
    #[account(mut)]
    pub relayer: Signer<'info>,
    pub pool: AccountLoader<'info, TokenPool>,
    /// CHECK: the pool's token account, checked by its seeds and read by hand.
    #[account(mut, seeds = [b"token-vault-account", pool.key().as_ref()], bump)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: PDA that owns the vault, checked by its seeds.
    #[account(seeds = [b"token-vault", pool.key().as_ref()], bump)]
    pub vault_authority: UncheckedAccount<'info>,
    /// CHECK: destination token account, bound by the proof's public inputs.
    #[account(mut)]
    pub recipient: UncheckedAccount<'info>,
    /// CHECK: where the relayer's fee lands, also bound by the proof.
    #[account(mut)]
    pub relayer_account: UncheckedAccount<'info>,
    #[account(
        init,
        payer = relayer,
        space = Nullifier::SIZE,
        seeds = [b"nullifier", pool.key().as_ref(), nullifier_hash.as_ref()],
        bump
    )]
    pub nullifier: Account<'info, Nullifier>,
    /// CHECK: the SPL token program, pinned by address.
    #[account(address = TOKEN_PROGRAM_ID)]
    pub token_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[event]
pub struct TokenPoolOpened {
    pub pool: Pubkey,
    pub mint: Pubkey,
    pub denomination: u64,
}

#[derive(Accounts)]
pub struct BurnForKey<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    /// One key per wallet: `init` makes a second one fail rather than reset it.
    #[account(init, payer = owner, space = BurnKey::SIZE, seeds = [b"key", owner.key().as_ref()], bump)]
    pub key: Account<'info, BurnKey>,
    /// CHECK: the KEEPHOST mint, pinned by address.
    #[account(mut, address = KEEPHOST_MINT)]
    pub mint: UncheckedAccount<'info>,
    /// CHECK: the holder's token account; its mint and owner are checked.
    #[account(mut)]
    pub from: UncheckedAccount<'info>,
    /// CHECK: the SPL token program, pinned by address.
    #[account(address = TOKEN_PROGRAM_ID)]
    pub token_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[account]
pub struct BurnKey {
    pub owner: Pubkey,
    pub burned: u64,
    pub at: i64,
    pub bump: u8,
}

impl BurnKey {
    pub const SIZE: usize = 8 + 32 + 8 + 8 + 1;
}

#[derive(Accounts)]
#[instruction(proof_a: [u8; 64], proof_b: [u8; 128], proof_c: [u8; 64], root: [u8; 32], nullifier_hash: [u8; 32])]
pub struct Withdraw<'info> {
    #[account(mut)]
    pub relayer: Signer<'info>,
    pub pool: AccountLoader<'info, Pool>,
    /// CHECK: vault PDA, checked by its seeds.
    #[account(mut, seeds = [b"vault", pool.key().as_ref()], bump)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: fee PDA, checked by its seeds. It pays the relayer when it can.
    #[account(mut, seeds = [b"fees", pool.key().as_ref()], bump)]
    pub fees: UncheckedAccount<'info>,
    /// CHECK: destination address, bound by the proof's public inputs.
    #[account(mut)]
    pub recipient: UncheckedAccount<'info>,
    #[account(
        init,
        payer = relayer,
        space = Nullifier::SIZE,
        seeds = [b"nullifier", pool.key().as_ref(), nullifier_hash.as_ref()],
        bump
    )]
    pub nullifier: Account<'info, Nullifier>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetPaused<'info> {
    pub authority: Signer<'info>,
    #[account(mut)]
    pub pool: AccountLoader<'info, Pool>,
}

#[event]
pub struct PoolOpened {
    pub pool: Pubkey,
    pub creator: Pubkey,
    pub denomination: u64,
}

#[event]
pub struct Deposited {
    pub pool: Pubkey,
    pub commitment: [u8; 32],
    pub leaf_index: u32,
    pub root: [u8; 32],
    pub at: i64,
}

#[event]
pub struct Withdrawn {
    pub pool: Pubkey,
    pub nullifier_hash: [u8; 32],
    pub recipient: Pubkey,
    pub relayer: Pubkey,
    pub fee: u64,
    pub at: i64,
}

#[event]
pub struct PauseChanged {
    pub pool: Pubkey,
    pub paused: bool,
}

#[event]
pub struct PauseRenounced {
    pub pool: Pubkey,
}

#[event]
pub struct KeyMinted {
    pub owner: Pubkey,
    pub burned: u64,
    pub at: i64,
}

#[error_code]
pub enum PoolError {
    #[msg("Burn at least the amount one key costs")]
    BurnTooSmall,
    #[msg("That token account is not the KEEPHOST mint")]
    WrongMint,
    #[msg("Denomination must cover the rent-exempt minimum")]
    BadDenomination,
    #[msg("New deposits are paused")]
    Paused,
    #[msg("Value is not a BN254 field element")]
    NotFieldElement,
    #[msg("This pool is full")]
    TreeFull,
    #[msg("Unknown or expired Merkle root")]
    UnknownRoot,
    #[msg("Relayer fee must be lower than the denomination")]
    FeeTooHigh,
    #[msg("Invalid withdrawal proof")]
    BadProof,
    #[msg("Poseidon hashing failed")]
    HashFailed,
    #[msg("This pool has no pause authority")]
    NoPauseAuthority,
    #[msg("Only the pause authority can do this")]
    NotPauseAuthority,
}

/// Compile-time guard: a degenerate (all-zero) verifying key would make any
/// proof verify, so refuse to build until the ceremony key is in place.
const _: () = assert!(VERIFYINGKEY.vk_alpha_g1[0] != 0 || VERIFYINGKEY.vk_alpha_g1[1] != 0);
const _: () = assert!(VERIFYINGKEY.nr_pubinputs == PUBLIC_INPUTS);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn poseidon_matches_circomlib() {
        for level in 0..LEVELS {
            let computed = poseidon2(&ZEROS[level], &ZEROS[level]).expect("hash");
            assert_eq!(
                computed, ZEROS[level + 1],
                "level {level}: the syscall Poseidon diverges from the circuit's"
            );
        }
    }

    #[test]
    fn split_is_injective() {
        let a = [0xffu8; 32];
        let mut b = [0xffu8; 32];
        b[0] = 0xfe;
        assert_ne!(split(&a), split(&b));
        let (hi, lo) = split(&a);
        assert!(is_field_element(&hi) && is_field_element(&lo));
    }

    #[test]
    fn field_bounds() {
        assert!(!is_field_element(&FIELD_MODULUS));
        let mut below = FIELD_MODULUS;
        below[31] -= 1;
        assert!(is_field_element(&below));
        assert!(is_field_element(&[0u8; 32]));
    }
}

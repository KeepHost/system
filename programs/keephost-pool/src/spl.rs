//! The three token program calls this pool needs, built by hand.
//!
//! anchor-spl brings a large surface into the binary — more than 100 kB, which
//! is rent paid for ever on a program account. These three instructions have a
//! layout that has not changed since the token program shipped, so writing
//! them out costs sixty lines and saves that rent.
//!
//! Layouts, from the SPL token program's instruction enum:
//!   3  Transfer            { amount: u64 }
//!   8  Burn                { amount: u64 }
//!   18 InitializeAccount3  { owner: Pubkey }

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::{invoke, invoke_signed};

/// The SPL token program. Passing anything else is refused by the callers.
pub const TOKEN_PROGRAM_ID: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

fn token_ix(data: Vec<u8>, metas: Vec<AccountMeta>) -> Instruction {
    Instruction { program_id: TOKEN_PROGRAM_ID, accounts: metas, data }
}

/// Moves `amount` from `from` to `to`, signed by `authority`.
pub fn transfer<'info>(
    token_program: &AccountInfo<'info>,
    from: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    amount: u64,
    signer_seeds: Option<&[&[&[u8]]]>,
) -> Result<()> {
    let mut data = vec![3u8];
    data.extend_from_slice(&amount.to_le_bytes());
    let ix = token_ix(
        data,
        vec![
            AccountMeta::new(from.key(), false),
            AccountMeta::new(to.key(), false),
            AccountMeta::new_readonly(authority.key(), signer_seeds.is_none()),
        ],
    );
    let accounts = [from.clone(), to.clone(), authority.clone(), token_program.clone()];
    match signer_seeds {
        Some(seeds) => invoke_signed(&ix, &accounts, seeds)?,
        None => invoke(&ix, &accounts)?,
    }
    Ok(())
}

/// Destroys `amount` of `mint` held by `from`. The tokens go nowhere.
pub fn burn<'info>(
    token_program: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    from: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    let mut data = vec![8u8];
    data.extend_from_slice(&amount.to_le_bytes());
    let ix = token_ix(
        data,
        vec![
            AccountMeta::new(from.key(), false),
            AccountMeta::new(mint.key(), false),
            AccountMeta::new_readonly(authority.key(), true),
        ],
    );
    invoke(&ix, &[from.clone(), mint.clone(), authority.clone(), token_program.clone()])?;
    Ok(())
}

/// Turns a freshly created account into a token account for `mint`, owned by
/// `owner`. The owner here is a PDA, so no human can sign for the vault.
pub fn initialize_account3<'info>(
    token_program: &AccountInfo<'info>,
    account: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    owner: &Pubkey,
) -> Result<()> {
    let mut data = vec![18u8];
    data.extend_from_slice(owner.as_ref());
    let ix = token_ix(
        data,
        vec![AccountMeta::new(account.key(), false), AccountMeta::new_readonly(mint.key(), false)],
    );
    invoke(&ix, &[account.clone(), mint.clone(), token_program.clone()])?;
    Ok(())
}

/// The mint and the owner of a token account, read from its raw bytes.
/// Layout: mint(32) · owner(32) · amount(8) · …
pub fn read_token_account(info: &AccountInfo) -> Result<(Pubkey, Pubkey)> {
    let data = info.try_borrow_data()?;
    require!(data.len() >= 64, crate::PoolError::WrongMint);
    require_keys_eq!(*info.owner, TOKEN_PROGRAM_ID, crate::PoolError::WrongMint);
    let mint = Pubkey::try_from(&data[0..32]).map_err(|_| error!(crate::PoolError::WrongMint))?;
    let owner = Pubkey::try_from(&data[32..64]).map_err(|_| error!(crate::PoolError::WrongMint))?;
    Ok((mint, owner))
}

import * as prompts from '@clack/prompts';

import { SetupFailure } from './cloudflare.ts';

export type Account = { id: string; name: string };
export type Answer = <T>(value: Promise<T>) => Promise<Exclude<T, symbol>>;

export const recoveryOptions = [
  { value: 'retry', label: 'Retry' },
  { value: 'account', label: 'Change account' },
] as const;

export async function selectAccount(
  accounts: Account[],
  answer: Answer,
  initialValue?: string,
  addAccount?: () => Promise<Account[]>,
) {
  while (true) {
    if (!addAccount && accounts.length === 0)
      throw new SetupFailure(
        'These credentials cannot access any Cloudflare accounts. Sign in with an account that has the required access.',
        'authentication',
      );
    const choice = await answer(
      prompts.select({
        message: 'Choose your Cloudflare account:',
        initialValue: accounts.some((account) => account.id === initialValue)
          ? initialValue
          : undefined,
        options: [
          ...accounts.map((account) => ({
            value: account.id,
            label: account.name,
            hint: account.id,
          })),
          ...(addAccount ? [{ value: 'add', label: 'Add account' }] : []),
        ],
      }),
    );
    if (choice === 'add' && addAccount) accounts = await addAccount();
    else return choice;
  }
}

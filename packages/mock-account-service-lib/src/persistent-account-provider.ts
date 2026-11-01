import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from 'fs'
import { dirname } from 'path'
import { AccountProvider } from './account-provider'

type Stored = Record<string, string | number>

const BIGINT_FIELDS = [
  'debitsPending',
  'debitsPosted',
  'creditsPending',
  'creditsPosted'
] as const

// An AccountProvider that keeps its accounts in a JSON file, so balances survive a restart of the mock account
// servicing entity. The file is written after every change (to a temporary file, then renamed into place).
export class PersistentAccountProvider extends AccountProvider {
  constructor(private readonly file: string) {
    super()
    if (existsSync(file)) {
      const stored: Stored[] = JSON.parse(readFileSync(file, 'utf8'))
      for (const account of stored) {
        const restored = { ...account } as Record<string, unknown>
        for (const field of BIGINT_FIELDS) {
          restored[field] = BigInt(account[field])
        }
        this.accounts.set(String(account.id), restored as never)
      }
      this.restored = this.accounts.size > 0
    }
  }

  private save(): void {
    const stored = [...this.accounts.values()].map((account) => {
      const plain: Stored = { ...account } as unknown as Stored
      for (const field of BIGINT_FIELDS)
        plain[field] = account[field].toString()
      return plain
    })
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(`${this.file}.tmp`, JSON.stringify(stored))
    renameSync(`${this.file}.tmp`, this.file)
  }

  async clearAccounts(): Promise<void> {
    await super.clearAccounts()
    this.save()
  }

  async setWalletAddress(
    id: string,
    walletID: string,
    walletAddress: string
  ): Promise<void> {
    await super.setWalletAddress(id, walletID, walletAddress)
    this.save()
  }

  async create(
    id: string,
    path: string,
    name: string,
    assetCode: string,
    assetScale: number,
    assetId: string
  ): Promise<void> {
    await super.create(id, path, name, assetCode, assetScale, assetId)
    this.save()
  }

  async set(id: string, name: string): ReturnType<AccountProvider['set']> {
    const account = await super.set(id, name)
    this.save()
    return account
  }

  async voidPendingDebit(id: string, amount: bigint): Promise<void> {
    await super.voidPendingDebit(id, amount)
    this.save()
  }

  async voidPendingCredit(id: string, amount: bigint): Promise<void> {
    await super.voidPendingCredit(id, amount)
    this.save()
  }

  async pendingDebit(id: string, amount: bigint): Promise<void> {
    await super.pendingDebit(id, amount)
    this.save()
  }

  async pendingCredit(id: string, amount: bigint): Promise<void> {
    await super.pendingCredit(id, amount)
    this.save()
  }

  async debit(
    id: string,
    amount: bigint,
    clearPending: boolean
  ): Promise<void> {
    await super.debit(id, amount, clearPending)
    this.save()
  }

  async credit(
    id: string,
    amount: bigint,
    clearPending: boolean
  ): Promise<void> {
    await super.credit(id, amount, clearPending)
    this.save()
  }
}

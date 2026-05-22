import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import { Transaction, Product, TransactionStatus, WorkflowLog } from '../../shared/types';

class TransactionStore {
  private transactions = new Map<string, Transaction>();
  private emitters = new Map<string, EventEmitter>();
  private logMap = new Map<string, WorkflowLog[]>();
  private smsCallbacks = new Map<string, (reply: string) => void>();

  create(product: Product, customerPhone: string): Transaction {
    const id = uuidv4();
    const now = new Date().toISOString();
    const t: Transaction = {
      id,
      product,
      customerPhone,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    };
    this.transactions.set(id, t);
    const emitter = new EventEmitter();
    emitter.setMaxListeners(30);
    this.emitters.set(id, emitter);
    this.logMap.set(id, []);
    return t;
  }

  get(id: string): Transaction | undefined {
    return this.transactions.get(id);
  }

  update(id: string, changes: Partial<Transaction>): Transaction | undefined {
    const t = this.transactions.get(id);
    if (!t) return undefined;
    const updated: Transaction = { ...t, ...changes, updatedAt: new Date().toISOString() };
    this.transactions.set(id, updated);
    return updated;
  }

  setStatus(id: string, status: TransactionStatus): void {
    this.update(id, { status });
    this.emit(id, 'status_update', { status });
  }

  getEmitter(id: string): EventEmitter | undefined {
    return this.emitters.get(id);
  }

  emit(id: string, event: string, data: unknown): void {
    this.emitters.get(id)?.emit(event, data);
  }

  addLog(id: string, log: WorkflowLog): void {
    this.logMap.get(id)?.push(log);
    this.emit(id, 'log', log);
  }

  getLogs(id: string): WorkflowLog[] {
    return this.logMap.get(id) ?? [];
  }

  setSmsCallback(phone: string, cb: (reply: string) => void): void {
    this.smsCallbacks.set(phone, cb);
  }

  resolveSmsCallback(phone: string, reply: string): boolean {
    const cb = this.smsCallbacks.get(phone);
    if (!cb) return false;
    cb(reply);
    this.smsCallbacks.delete(phone);
    return true;
  }

  hasPendingSms(phone: string): boolean {
    return this.smsCallbacks.has(phone);
  }

  findTransactionByOrder(orderId: string): Transaction | undefined {
    for (const t of this.transactions.values()) {
      if (t.paypalOrderId === orderId) return t;
    }
    return undefined;
  }

  findLatestTransactionByPhone(phone: string): Transaction | undefined {
    let latest: Transaction | undefined;
    for (const t of this.transactions.values()) {
      if (t.customerPhone !== phone) continue;
      if (!latest || t.updatedAt > latest.updatedAt) latest = t;
    }
    return latest;
  }
}

export const store = new TransactionStore();

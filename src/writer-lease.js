// Durable single-writer fencing for a Postgres-backed serving process.

export class WriterLeaseController {
  constructor(store, { name = 'primary', owner, leaseMs = 30_000, onLost = null } = {}) {
    if (!store || typeof store.acquireWriterLeaseAsync !== 'function') throw new Error('writer lease requires a Postgres store');
    this.store = store;
    this.name = name;
    this.owner = owner;
    this.leaseMs = Math.min(86_400_000, Math.max(1_000, Math.trunc(leaseMs)));
    this.onLost = onLost;
    this.lease = null;
    this.timer = null;
    this.lost = false;
    this.renewing = false;
    this.stopped = false;
  }

  async start() {
    this.stopped = false;
    await this._acquire();
    const intervalMs = Math.max(1_000, Math.floor(this.leaseMs / 3));
    this.timer = setInterval(() => { void this._renew(); }, intervalMs);
    this.timer.unref?.();
    return this;
  }

  async _acquire() {
    if (this.stopped) return false;
    try {
      const lease = await this.store.acquireWriterLeaseAsync({ name: this.name, owner: this.owner, leaseMs: this.leaseMs });
      if (this.stopped) {
        await this.store.releaseWriterLeaseAsync({ name: this.name, owner: this.owner, fencingToken: lease.fencingToken });
        return false;
      }
      this.lease = lease;
      this.lost = false;
      return true;
    } catch (error) {
      if (error?.code === 'WRITER_LEASE_HELD') return false;
      throw error;
    }
  }

  async _renew() {
    if (this.renewing || this.lost) return;
    this.renewing = true;
    try {
      if (!this.lease) {
        await this._acquire();
        return;
      }
      const renewed = await this.store.renewWriterLeaseAsync({
        name: this.name,
        owner: this.owner,
        fencingToken: this.lease.fencingToken,
        leaseMs: this.leaseMs,
      });
      if (renewed) this.lease = renewed;
      else await this._markLost();
    } catch {
      await this._markLost();
    } finally {
      this.renewing = false;
    }
  }

  async _markLost() {
    if (this.lost) return;
    this.lost = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.onLost?.();
  }

  async assertAsync() {
    if (this.lost || !this.lease) {
      const error = new Error('writer lease is not valid');
      error.code = 'WRITER_LEASE_LOST';
      throw error;
    }
    try {
      return await this.store.assertWriterLeaseAsync({
        name: this.name,
        owner: this.owner,
        fencingToken: this.lease.fencingToken,
      });
    } catch (error) {
      await this._markLost();
      throw error;
    }
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const lease = this.lease;
    this.lease = null;
    if (lease) await this.store.releaseWriterLeaseAsync({ name: this.name, owner: this.owner, fencingToken: lease.fencingToken });
  }
}

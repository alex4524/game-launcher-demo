import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface Settings {
  deviceId: string;
  rememberedCdn: string | null;
}

/** Small JSON settings file in userData. Writes are atomic (tmp + rename). */
export class SettingsStore {
  data: Settings;

  constructor(private readonly file: string) {
    let loaded: Partial<Settings> = {};
    try {
      loaded = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      /* first run */
    }
    this.data = {
      deviceId: typeof loaded.deviceId === 'string' && /^[\w-]{8,64}$/.test(loaded.deviceId) ? loaded.deviceId : randomUUID(),
      rememberedCdn: typeof loaded.rememberedCdn === 'string' ? loaded.rememberedCdn : null,
    };
    void this.save();
  }

  async update(patch: Partial<Settings>): Promise<void> {
    Object.assign(this.data, patch);
    await this.save();
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(this.data, null, 2));
    await rename(tmp, this.file);
  }
}

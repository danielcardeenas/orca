/**
 * Bóveda local de credenciales.
 *
 * Invariante que define este archivo: el VALOR de una key nunca sale del
 * proceso por el websocket. Sale por exactamente una puerta — `materialize()`,
 * que construye el env de un proceso hijo — y por ninguna otra. Todo lo demás
 * que este módulo expone es `KeyDescriptor`: nombre, últimos 4 caracteres, y
 * auditoría de quién la leyó.
 *
 * En disco:
 *   ~/.orca/secret      32 bytes aleatorios, 0600. La raíz de confianza.
 *   ~/.orca/keys.json   0600. Cada entrada cifrada con AES-256-GCM bajo una
 *                       clave derivada por scrypt del secreto + un salt propio.
 *
 * Salt por entrada (y no uno global) para que dos entradas con el mismo valor
 * no produzcan el mismo ciphertext: quien lea el archivo no debe poder deducir
 * que dos proyectos comparten credencial.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { KeyDescriptor } from '../shared/types.ts';
import { errText, isRecord, log, orcaDir, safeJson, str } from './util.ts';

const SCOPE = 'keys';
const FILE_VERSION = 1;
const SCRYPT_N = 16384, SCRYPT_r = 8, SCRYPT_p = 1, KEY_LEN = 32;

interface Entry {
  projectId: string;
  name: string;
  hint: string;
  addedAt: number;
  lastUsedAt: number | null;
  usedBy: string[];
  /** base64 */
  salt: string;
  iv: string;
  tag: string;
  ct: string;
}

export function keyId(projectId: string, name: string): string {
  return `${projectId}::${name}`;
}

export class KeyVault {
  private readonly dir: string;
  private readonly secretPath: string;
  private readonly filePath: string;
  private secret: Buffer | null = null;
  private entries = new Map<string, Entry>();
  private loaded = false;

  constructor(dir = orcaDir()) {
    this.dir = dir;
    this.secretPath = path.join(dir, 'secret');
    this.filePath = path.join(dir, 'keys.json');
  }

  /* ── raíz de confianza ────────────────────────────────────────── */

  private ensureSecret(): Buffer {
    if (this.secret) return this.secret;
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(this.dir, 0o700); } catch { /* en algunos FS no aplica */ }
    if (fs.existsSync(this.secretPath)) {
      const buf = fs.readFileSync(this.secretPath);
      if (buf.length >= 32) { this.secret = buf; return buf; }
      log('warn', SCOPE, 'secret corto o corrupto, regenerando (las keys previas se pierden)');
    }
    const fresh = crypto.randomBytes(32);
    // wx: si otro collector lo creó en la carrera, releemos el suyo.
    try {
      fs.writeFileSync(this.secretPath, fresh, { mode: 0o600, flag: 'wx' });
      this.secret = fresh;
    } catch {
      this.secret = fs.readFileSync(this.secretPath);
    }
    try { fs.chmodSync(this.secretPath, 0o600); } catch { /* idem */ }
    return this.secret;
  }

  private derive(salt: Buffer): Buffer {
    return crypto.scryptSync(this.ensureSecret(), salt, KEY_LEN, {
      N: SCRYPT_N, r: SCRYPT_r, p: SCRYPT_p,
      // scrypt con N=16384 pide más memoria que el default de Node.
      maxmem: 64 * 1024 * 1024,
    });
  }

  /* ── persistencia ─────────────────────────────────────────────── */

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!fs.existsSync(this.filePath)) return;
    let text = '';
    try { text = fs.readFileSync(this.filePath, 'utf8'); } catch (err) {
      log('warn', SCOPE, `no pude leer keys.json: ${errText(err)}`);
      return;
    }
    const obj = safeJson<{ v?: unknown; entries?: unknown }>(text);
    if (!obj || !Array.isArray(obj.entries)) {
      log('warn', SCOPE, 'keys.json ilegible, arrancando vacío (no lo sobrescribo hasta un set)');
      return;
    }
    for (const raw of obj.entries) {
      if (!isRecord(raw)) continue;
      const projectId = str(raw['projectId']);
      const name = str(raw['name']);
      const ct = str(raw['ct']);
      const iv = str(raw['iv']);
      const tag = str(raw['tag']);
      const salt = str(raw['salt']);
      if (!projectId || !name || !ct || !iv || !tag || !salt) continue;
      this.entries.set(keyId(projectId, name), {
        projectId, name, ct, iv, tag, salt,
        hint: str(raw['hint']) ?? '····',
        addedAt: typeof raw['addedAt'] === 'number' ? raw['addedAt'] : Date.now(),
        lastUsedAt: typeof raw['lastUsedAt'] === 'number' ? raw['lastUsedAt'] : null,
        usedBy: Array.isArray(raw['usedBy'])
          ? raw['usedBy'].filter((u): u is string => typeof u === 'string') : [],
      });
    }
  }

  private persist(): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const body = JSON.stringify(
        { v: FILE_VERSION, entries: [...this.entries.values()] }, null, 2,
      );
      // Escritura atómica: un corte a media escritura no debe dejar la bóveda
      // truncada, que sería equivalente a perder las credenciales.
      const tmp = this.filePath + '.tmp';
      fs.writeFileSync(tmp, body, { mode: 0o600 });
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      log('error', SCOPE, `no pude persistir keys.json: ${errText(err)}`);
    }
  }

  /* ── API pública ──────────────────────────────────────────────── */

  set(projectId: string, name: string, value: string): KeyDescriptor {
    this.load();
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const key = this.derive(salt);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    // El id de la entrada va como AAD: mover un ciphertext de un proyecto a
    // otro editando el JSON rompe la autenticación.
    cipher.setAAD(Buffer.from(keyId(projectId, name), 'utf8'));
    const ct = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    const prev = this.entries.get(keyId(projectId, name));
    const entry: Entry = {
      projectId, name,
      hint: value.length >= 4 ? value.slice(-4) : '·'.repeat(Math.max(1, value.length)),
      addedAt: prev?.addedAt ?? Date.now(),
      lastUsedAt: prev?.lastUsedAt ?? null,
      usedBy: prev?.usedBy ?? [],
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      ct: ct.toString('base64'),
    };
    this.entries.set(keyId(projectId, name), entry);
    this.persist();
    return describe(entry);
  }

  remove(projectId: string, name: string): boolean {
    this.load();
    const ok = this.entries.delete(keyId(projectId, name));
    if (ok) this.persist();
    return ok;
  }

  /** Lo único que se envía por el websocket. */
  list(): KeyDescriptor[] {
    this.load();
    return [...this.entries.values()].map(describe);
  }

  namesFor(projectId: string): string[] {
    this.load();
    return [...this.entries.values()]
      .filter((e) => e.projectId === projectId)
      .map((e) => e.name)
      .sort();
  }

  /** Descifra una sola. Privado por diseño: sólo `materialize` lo usa. */
  private reveal(entry: Entry): string | null {
    try {
      const key = this.derive(Buffer.from(entry.salt, 'base64'));
      const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(entry.iv, 'base64'));
      d.setAAD(Buffer.from(keyId(entry.projectId, entry.name), 'utf8'));
      d.setAuthTag(Buffer.from(entry.tag, 'base64'));
      const out = Buffer.concat([
        d.update(Buffer.from(entry.ct, 'base64')), d.final(),
      ]);
      return out.toString('utf8');
    } catch (err) {
      // Tag inválido = archivo manipulado o secret cambiado. No es recuperable.
      log('error', SCOPE, `no pude descifrar ${entry.name}: ${errText(err)}`);
      return null;
    }
  }

  /**
   * El env a inyectar al lanzar un agente en este proyecto. ÚNICA salida de
   * valores en claro, y sólo hacia el env de un hijo — nunca hacia un frame.
   */
  materialize(projectId: string, usedBy?: string): Record<string, string> {
    this.load();
    const env: Record<string, string> = {};
    let touched = false;
    for (const entry of this.entries.values()) {
      if (entry.projectId !== projectId) continue;
      const value = this.reveal(entry);
      if (value === null) continue;
      env[entry.name] = value;
      entry.lastUsedAt = Date.now();
      if (usedBy && !entry.usedBy.includes(usedBy)) {
        entry.usedBy = [...entry.usedBy, usedBy].slice(-50);
      }
      touched = true;
    }
    if (touched) this.persist();
    return env;
  }

  /** Sólo para tests: verifica el round-trip sin exponer la API. */
  selfTest(projectId: string, name: string, expected: string): boolean {
    this.load();
    const entry = this.entries.get(keyId(projectId, name));
    if (!entry) return false;
    return this.reveal(entry) === expected;
  }
}

function describe(e: Entry): KeyDescriptor {
  return {
    name: e.name,
    projectId: e.projectId,
    hint: e.hint,
    addedAt: e.addedAt,
    lastUsedAt: e.lastUsedAt,
    usedBy: [...e.usedBy],
  };
}

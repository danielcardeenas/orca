/**
 * Archivos del operador colocados en el campo.
 *
 * Una imagen soltada en el lienzo se ve en el lienzo. Eso es todo lo que
 * pide el gesto, y el campo ya sabe hacerlo por los artefactos: un
 * `Artifact` con `placement` es un cuadro con textura sobre el plano
 * (field/media.ts). Así que un archivo colocado es un artefacto sin agente:
 * el hub lo guardó en `~/.orca/uploads` (hub/uploads.ts), `/api/file` lo
 * sirve, y aquí se recuerda dónde lo dejó el operador.
 *
 * Es local a esta consola, como las colocaciones de los artefactos y de las
 * baldosas (`orca.artifacts.placed.v1`, `orca.placements.v2`): el hub no
 * tiene un canal de colocaciones y no se inventa uno para esto. Otra consola
 * no lo ve; un reload sí.
 *
 * Sin DOM: `createPlacedFiles` recibe el storage, y test/placed-files.test.ts
 * lo ejercita sin navegador. `placedFiles` es el de la consola.
 */

import type { Artifact, ArtifactKind } from '../shared/types.ts';
import type { StorageLike } from './drafts.ts';
import { baseName, fileKind } from './windows/paths.ts';

export const PLACED_FILES_KEY = 'orca.files.placed.v1';
/** Un id que no puede chocar con los del hub: los suyos no llevan `:`. */
export const FILE_ID_PREFIX = 'file:';
/** Más superficies que esto y el campo deja de ser un campo; media.ts corta en 40 con los artefactos. */
export const MAX_PLACED_FILES = 40;

export interface Placement { x: number; y: number; z: number }

export interface PlacedFile {
  id: string;
  /** Ruta absoluta en el disco del hub. */
  path: string;
  kind: ArtifactKind;
  placement: Placement;
  at: number;
}

export function isPlacedFileId(id: string): boolean { return id.startsWith(FILE_ID_PREFIX); }
export function placedFileId(path: string): string { return `${FILE_ID_PREFIX}${path}`; }

/** Lo que el campo sabe dibujar como superficie; lo demás va a una caja. */
export function fieldKindOf(path: string): ArtifactKind | null {
  const k = fileKind(path);
  return k === 'image' || k === 'video' ? k : null;
}

export interface PlacedFiles {
  list(): PlacedFile[];
  get(id: string): PlacedFile | undefined;
  /** Coloca (o recoloca, si ya estaba) el archivo. Null: no cabe uno más. */
  add(path: string, placement: Placement, now?: number): PlacedFile | null;
  move(id: string, placement: Placement): boolean;
  remove(id: string): boolean;
  /** Los mismos, con la forma que field/media.ts dibuja. */
  artifacts(): Artifact[];
}

export function createPlacedFiles(storage: StorageLike | null): PlacedFiles {
  let files: PlacedFile[] = load();

  function load(): PlacedFile[] {
    try {
      const raw = storage?.getItem(PLACED_FILES_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((f): f is PlacedFile => !!f && typeof f === 'object'
        && typeof (f as PlacedFile).path === 'string' && typeof (f as PlacedFile).placement?.x === 'number')
        .map((f) => ({ ...f, id: placedFileId(f.path), kind: fieldKindOf(f.path) ?? 'file' }))
        .slice(0, MAX_PLACED_FILES);
    } catch { return []; }
  }

  function save(): void {
    try { storage?.setItem(PLACED_FILES_KEY, JSON.stringify(files)); } catch { /* modo privado o storage lleno */ }
  }

  return {
    list: () => [...files],
    get: (id) => files.find((f) => f.id === id),
    add(path, placement, now = Date.now()) {
      const id = placedFileId(path);
      const existing = files.find((f) => f.id === id);
      if (existing) { existing.placement = placement; save(); return existing; }
      if (files.length >= MAX_PLACED_FILES) return null;
      const f: PlacedFile = { id, path, kind: fieldKindOf(path) ?? 'file', placement, at: now };
      files = [...files, f];
      save();
      return f;
    },
    move(id, placement) {
      const f = files.find((x) => x.id === id);
      if (!f) return false;
      f.placement = placement;
      save();
      return true;
    },
    remove(id) {
      const before = files.length;
      files = files.filter((f) => f.id !== id);
      if (files.length === before) return false;
      save();
      return true;
    },
    artifacts() {
      return files.map((f): Artifact => ({
        id: f.id, agentId: '', projectId: '', machineId: '', kind: f.kind, path: f.path,
        title: baseName(f.path), url: `/api/file?path=${encodeURIComponent(f.path)}`,
        bytes: 0, width: null, height: null, at: f.at, open: false, placement: { ...f.placement },
      }));
    },
  };
}

function browserStorage(): StorageLike | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

export const placedFiles: PlacedFiles = createPlacedFiles(browserStorage());

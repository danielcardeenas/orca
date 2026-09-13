/**
 * Tipos para `project-root.mjs`. Mismo motivo que `whoami.d.mts`: el módulo es
 * JS suelto porque `bin/` lo ejecuta node directamente, y la prueba es
 * TypeScript.
 */

export declare function foldWorktree(dir: string): string;
export declare function projectRoot(explicit?: string | null, cwd?: string): string;

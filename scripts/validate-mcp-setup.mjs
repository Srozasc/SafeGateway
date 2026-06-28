#!/usr/bin/env node
/**
 * Smoke test para validar que el setup del MCP de Obsidian funciona end-to-end.
 *
 * Validación estática (rápida, sin red):
 *   1. .mcp.json existe y es JSON válido.
 *   2. Estructura mcpServers.obsidian con command/args correctos.
 *   3. La carpeta del vault (.brain/) existe.
 *   4. La nota de prueba (.brain/00-inbox/welcome.md) existe.
 *
 * Validación dinámica (requiere npx + red, falla graceful):
 *   5. El server MCP arranca y responde a initialize.
 *   6. tools/list devuelve 14 herramientas.
 *   7. read_note devuelve el contenido de la nota de prueba.
 *
 * Exit codes:
 *   0  — todo OK (o solo la parte dinámica falló por entorno).
 *   1  — la validación estática falló, el setup no es utilizable.
 */

import { spawn } from 'node:child_process';
import { readFile, stat, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

const VAULT_PATH = join(projectRoot, '.brain');
const MCP_CONFIG_PATH = join(projectRoot, '.mcp.json');
const TEST_NOTE_REL = '00-inbox/welcome.md';
const TEST_NOTE_ABS = join(VAULT_PATH, TEST_NOTE_REL);
const MCP_PACKAGE = '@bitbonsai/mcpvault@latest';

let pass = 0;
let fail = 0;

const C = { green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', dim: '\x1b[2m', reset: '\x1b[0m' };

function check(label, ok, detail = '') {
  const tag = ok ? `${C.green} PASS ${C.reset}` : `${C.red} FAIL ${C.reset}`;
  console.log(`[${tag}] ${label}${detail ? ` ${C.dim}—${C.reset} ${detail}` : ''}`);
  ok ? pass++ : fail++;
}

function warn(label, detail = '') {
  console.log(`[${C.yellow} SKIP ${C.reset}] ${label}${detail ? ` ${C.dim}—${C.reset} ${detail}` : ''}`);
}

// ─── Validación estática ────────────────────────────────────────────────────

async function validateStatic() {
  console.log(`\n${C.dim}=== Validación estática ===${C.reset}\n`);

  // 1. .mcp.json existe y es JSON válido
  let config;
  try {
    const raw = await readFile(MCP_CONFIG_PATH, 'utf8');
    config = JSON.parse(raw);
    check('.mcp.json existe y es JSON válido', true);
  } catch (err) {
    check('.mcp.json existe y es JSON válido', false, err.message);
    return false;
  }

  // 2. Estructura esperada
  const server = config?.mcpServers?.obsidian;
  const hasServer = !!server;
  check('mcpServers.obsidian presente', hasServer);
  if (!hasServer) return false;
  check('command = npx', server.command === 'npx', `got: ${server.command}`);
  check(`args incluye ${MCP_PACKAGE}`, server.args?.includes(MCP_PACKAGE));
  check('args incluye ".brain" (vault path relativo)', server.args?.includes('.brain'));

  // 3. Vault existe
  try {
    const stats = await stat(VAULT_PATH);
    check('.brain/ existe', stats.isDirectory());
  } catch {
    check('.brain/ existe', false, `${VAULT_PATH} no encontrado`);
    return false;
  }

  // 4. Nota de prueba existe
  try {
    await access(TEST_NOTE_ABS);
    check(`Nota de prueba existe: ${TEST_NOTE_REL}`, true);
  } catch {
    check(`Nota de prueba existe: ${TEST_NOTE_REL}`, false);
    return false;
  }

  return true;
}

// ─── Validación dinámica (MCP JSON-RPC sobre stdio) ─────────────────────────

/**
 * Envía un mensaje JSON-RPC al MCP server por stdio y espera la respuesta
 * con el id correspondiente. Protocolo: newline-delimited JSON.
 */
function mcpCall(proc, method, params = {}, id = 1) {
  return new Promise((resolveP, rejectP) => {
    const message = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    let buffer = '';
    // Timeout largo: la primera ejecución descarga el paquete vía npx y puede tardar.
    const timeout = setTimeout(() => {
      proc.stdout.off('data', onData);
      rejectP(new Error(`Timeout esperando respuesta a ${method} (45s)`));
    }, 45_000);

    const onData = (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const response = JSON.parse(line);
          if (response.id === id) {
            clearTimeout(timeout);
            proc.stdout.off('data', onData);
            resolveP(response);
            return;
          }
        } catch {
          // Ignora líneas que no son JSON-RPC (logs del server, etc.)
        }
      }
    };
    proc.stdout.on('data', onData);
    try {
      proc.stdin.write(message);
    } catch (err) {
      clearTimeout(timeout);
      proc.stdout.off('data', onData);
      rejectP(err);
    }
  });
}

async function validateDynamic() {
  console.log(`\n${C.dim}=== Validación dinámica (spawn MCP server) ===${C.reset}\n`);

  // En Windows, `npx` resuelve a `npx.cmd` (script CMD), y bash de Git no lo
  // encuentra sin el sufijo ni con shell:true. Forzamos el binario correcto.
  const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';

  let proc;
  try {
    proc = spawn(npxCmd, ['-y', MCP_PACKAGE, '.brain'], {
      cwd: projectRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      // shell:true es necesario en Windows para ejecutar .cmd/.bat sin EINVAL.
      // Node escapa automáticamente los args del array, no hay riesgo de inyección.
      shell: true,
      windowsHide: true,
    });
  } catch (err) {
    warn('No se pudo arrancar npx', err.message);
    return;
  }

  let stderr = '';
  let rawStdout = '';
  proc.stderr.on('data', (d) => { stderr += d.toString(); });
  proc.stdout.on('data', (d) => { rawStdout += d.toString(); });
  proc.on('error', (err) => warn('npx falló al spawn', err.message));

  try {
    // 5. initialize
    const init = await mcpCall(proc, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'validate-mcp-setup', version: '1.0.0' },
    });
    check('MCP server responde a initialize', !init.error, init.error?.message);

    // Tras initialize, MCP exige enviar la notificación initialized
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

    // 6. tools/list
    const toolsResp = await mcpCall(proc, 'tools/list', {}, 2);
    const toolNames = toolsResp.result?.tools?.map((t) => t.name) || [];
    check(
      'tools/list devuelve 15 herramientas (mcpvault v0.11+)',
      toolNames.length === 15,
      `${toolNames.length} herramientas${toolNames.length ? ` (${toolNames.slice(0, 4).join(', ')}...)` : ''}`,
    );

    // 7. read_note (con prettyPrint para obtener fm + content estructurado)
    const readResp = await mcpCall(proc, 'tools/call', {
      name: 'read_note',
      arguments: { path: TEST_NOTE_REL, prettyPrint: true },
    }, 3);

    if (readResp.error) {
      check('read_note sobre la nota de prueba', false, readResp.error.message);
    } else {
      const text = readResp.result?.content?.[0]?.text || '';
      check('read_note devuelve contenido', text.length > 0, `${text.length} chars`);

      // El texto es JSON con { fm, content } cuando prettyPrint=true
      let parsed = null;
      try { parsed = JSON.parse(text); } catch { /* no es JSON */ }

      if (parsed?.content) {
        check('read_note preserva el body', parsed.content.includes('Bienvenida'));
      } else {
        check('read_note preserva el body', text.includes('Bienvenida'));
      }

      if (parsed?.fm?.tags) {
        check('read_note expone frontmatter (fm.tags)', Array.isArray(parsed.fm.tags));
      } else {
        check('read_note expone frontmatter (fm.tags)', false, 'no se encontró fm.tags en la respuesta');
      }
    }
  } catch (err) {
    warn('Validación dinámica abortada', err.message);
    if (stderr.trim()) {
      console.log(`  ${C.dim}stderr:${C.reset} ${stderr.trim().split('\n').slice(0, 5).join(' | ')}`);
    }
    if (rawStdout.trim()) {
      console.log(`  ${C.dim}stdout (raw):${C.reset} ${rawStdout.trim().split('\n').slice(0, 5).join(' | ')}`);
    }
  } finally {
    proc.kill();
  }
}

// ─── Entry point ────────────────────────────────────────────────────────────

async function main() {
  console.log('Validando setup de MCP (Obsidian vault)...\n');
  console.log(`${C.dim}Project root:${C.reset} ${projectRoot}`);
  console.log(`${C.dim}Vault path:${C.reset}   ${VAULT_PATH}`);

  const staticOk = await validateStatic();
  if (!staticOk) {
    console.log(`\n${C.red}Falló la validación estática.${C.reset} El setup no es utilizable.`);
    console.log(`Resultado: ${C.green}${pass} pass${C.reset}, ${C.red}${fail} fail${C.reset}\n`);
    process.exit(1);
  }

  await validateDynamic();

  console.log(`\nResultado: ${C.green}${pass} pass${C.reset}, ${fail > 0 ? `${C.red}${fail} fail${C.reset}` : `${C.green}0 fail${C.reset}`}`);
  if (fail > 0) {
    console.log(`${C.yellow}Hay fallos en la validación dinámica.${C.reset} Revisa el setup o la conectividad.`);
  }
  console.log();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`${C.red}Error inesperado:${C.reset}`, err);
  process.exit(1);
});

import fs from 'fs';

// 1. Corregir retry.test.ts
const retryPath = 'd:/desarrollo/Gateway/tests/unit/middleware/circuit-breaker/retry.test.ts';
let retryContent = fs.readFileSync(retryPath, 'utf-8');
// Agregar importación de vitest
retryContent = "import { vi, describe, it, expect, beforeEach } from 'vitest';\n" + retryContent;
// Reemplazar jest. por vi.
retryContent = retryContent.replace(/\bjest\./g, 'vi.');
retryContent = retryContent.replace(/\bjest\b/g, 'vi');
fs.writeFileSync(retryPath, retryContent, 'utf-8');
console.log('retry.test.ts modificado.');

// 2. Corregir state.test.ts
const statePath = 'd:/desarrollo/Gateway/tests/unit/middleware/circuit-breaker/state.test.ts';
let stateContent = fs.readFileSync(statePath, 'utf-8');
// Agregar importación de vitest
stateContent = "import { vi, describe, it, expect, beforeEach } from 'vitest';\n" + stateContent;
// Reemplazar jest. por vi.
stateContent = stateContent.replace(/\bjest\./g, 'vi.');
stateContent = stateContent.replace(/\bjest\b/g, 'vi');

// Reemplazar jest.sleep(10) por await new Promise(resolve => setTimeout(resolve, 10))
// y convertir las funciones correspondientes a async
stateContent = stateContent.replace(
  /it\('should transition to HALF_OPEN after recovery time', \(\) => \{/g,
  "it('should transition to HALF_OPEN after recovery time', async () => {"
);
stateContent = stateContent.replace(
  /it\('should close after halfOpenRequests successful requests', \(\) => \{/g,
  "it('should close after halfOpenRequests successful requests', async () => {"
);
stateContent = stateContent.replace(
  /it\('should reopen circuit if request fails in HALF_OPEN', \(\) => \{/g,
  "it('should reopen circuit if request fails in HALF_OPEN', async () => {"
);

stateContent = stateContent.replace(/vi\.sleep\(10\);/g, "await new Promise(resolve => setTimeout(resolve, 10));");

fs.writeFileSync(statePath, stateContent, 'utf-8');
console.log('state.test.ts modificado.');

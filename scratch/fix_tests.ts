import fs from 'fs';
import path from 'path';

const testsDir = 'd:/desarrollo/Gateway/tests';

function walkDir(dir: string, fileList: string[] = []): string[] {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      walkDir(filePath, fileList);
    } else if (file.endsWith('.test.ts')) {
      fileList.push(filePath);
    }
  }
  return fileList;
}

const testFiles = walkDir(testsDir);

for (const file of testFiles) {
  let content = fs.readFileSync(file, 'utf-8');
  if (content.includes('@jest/globals')) {
    console.log(`Modificando: ${file}`);
    
    // Reemplazar la importación de @jest/globals
    // Casos:
    // import { ... } from '@jest/globals';
    // import { jest, ... } from '@jest/globals';
    
    content = content.replace(/from '@jest\/globals'/g, "from 'vitest'");
    
    // Reemplazar la palabra importada jest por vi si existe
    content = content.replace(/\bjest\b/g, "vi");
    
    // Reemplazar llamadas a jest.fn() u otras llamadas a jest. por vi.
    content = content.replace(/\bjest\./g, "vi.");
    
    fs.writeFileSync(file, content, 'utf-8');
  }
}

console.log('Migración a Vitest completada.');

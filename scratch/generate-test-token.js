import { SignJWT } from 'jose';

const SECRET_KEY = 'secreto-para-pruebas-locales-de-32-chars!!!';

async function main() {
  const payload = {
    sub: 'dev-user-123',
    role: 'superadmin',
    email: 'admin@gateway.local',
  };

  const encodedSecret = new TextEncoder().encode(SECRET_KEY);
  
  const token = await new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('2h')
    .sign(encodedSecret);

  console.log('\n=========================================');
  console.log('Token JWT de Prueba Generado con Éxito');
  console.log('=========================================');
  console.log(`Claims inyectados:`, JSON.stringify(payload, null, 2));
  console.log(`Clave Secreta: ${SECRET_KEY}`);
  console.log('=========================================');
  console.log('TOKEN:');
  console.log(token);
  console.log('=========================================\n');
}

main().catch(console.error);

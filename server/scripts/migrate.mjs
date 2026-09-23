// Applies every .sql file in migrations/ in filename order.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(__dirname, '../migrations');

if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
}

if (/^memory:/i.test(process.env.DATABASE_URL)) {
    console.log('memory mode: no migrations to run.');
    process.exit(0);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });

try {
    await client.connect();
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
    for (const file of files) {
        process.stdout.write(`applying ${file} ... `);
        await client.query(fs.readFileSync(path.join(dir, file), 'utf8'));
        console.log('ok');
    }
    console.log(`done, ${files.length} migration(s) applied.`);
} catch (err) {
    console.error('\nmigration failed:', err.message);
    process.exitCode = 1;
} finally {
    await client.end();
}

// Generates EDITOR_PASSWORD_HASH locally.
//
// The plaintext is read from a prompt with echo off and never written to disk,
// never printed, and never sent anywhere. Only the resulting hash is shown.
import readline from 'node:readline';
import crypto from 'node:crypto';

function hashPassword(plain) {
    const N = 16384, r = 8, p = 1, keyLen = 32;
    const salt = crypto.randomBytes(16);
    const key = crypto.scryptSync(plain, salt, keyLen, { N, r, p, maxmem: 64 * 1024 * 1024 });
    return ['scrypt', N, r, p, salt.toString('base64url'), key.toString('base64url')].join(':');
}

function askHidden(question) {
    return new Promise(resolve => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
        const onData = char => {
            if ([ '\n', '\r', '\u0004' ].includes(char.toString())) return;
            // Redraw the prompt without the typed characters.
            readline.clearLine(process.stdout, 0);
            readline.cursorTo(process.stdout, 0);
            process.stdout.write(question);
        };
        process.stdin.on('data', onData);
        rl.question(question, answer => {
            process.stdin.removeListener('data', onData);
            rl.close();
            process.stdout.write('\n');
            resolve(answer);
        });
    });
}

const password = (await askHidden('Editor password: ')).trim();
if (password.length < 8) {
    console.error('Too short - use at least 8 characters.');
    process.exit(1);
}
const confirm = (await askHidden('Repeat password: ')).trim();
if (password !== confirm) {
    console.error('Passwords do not match.');
    process.exit(1);
}

console.log('\nPut this in your .env (or Sealed Secret) as EDITOR_PASSWORD_HASH:\n');
console.log(hashPassword(password));
console.log('\nSESSION_SECRET (random, also needed):\n');
console.log(crypto.randomBytes(48).toString('base64url'));

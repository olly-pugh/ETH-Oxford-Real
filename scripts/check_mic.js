const fs = require('fs');
const crypto = require('crypto');

// The user suggested using ethers.utils.sha256 or Node crypto.
// I'll use Node crypto for simplicity and to avoid dependency issues if ethers is not globally available
// or if there are version discrepancies, although ethers is in package.json.
// Actually, I'll use Node crypto as it's built-in.

const fileBuffer = fs.readFileSync('api_response.json');
const hash = crypto.createHash('sha256').update(fileBuffer).digest('hex');

console.log('0x' + hash);

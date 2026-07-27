const https = require('https');
https.get('https://bitgetlimited.github.io/apidoc/en/mix/', (resp) => {
  let data = '';
  resp.on('data', (chunk) => { data += chunk; });
  resp.on('end', () => {
    const lines = data.split('\n');
    lines.forEach((line, i) => {
      if (line.includes('place-tpsl-order')) {
         console.log(lines.slice(i-2, i+15).join('\n'));
      }
    });
  });
}).on("error", (err) => {
  console.log("Error: " + err.message);
});

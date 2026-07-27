const https = require('https');
https.get('https://bitgetlimited.github.io/apidoc/en/mix/', (resp) => {
  let data = '';
  resp.on('data', (chunk) => { data += chunk; });
  resp.on('end', () => {
    // extract place-tpsl-order
    const index = data.indexOf('place-tpsl-order');
    console.log("Found at index: " + index);
  });
}).on("error", (err) => {
  console.log("Error: " + err.message);
});

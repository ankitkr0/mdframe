const express = require('express');
const Jimp = require('jimp');
const fs = require('fs').promises;
const { getSSLHubRpcClient, Message } = require('@farcaster/hub-nodejs');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

// Add CORS headers
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});

// Grid configuration
const GRID_SIZE = 1000;
const TOKEN_SIZE = 10;

let grid = Array(GRID_SIZE).fill().map(() => Array(GRID_SIZE).fill(null));
let userPixels = {};

async function loadData() {
  try {
    const gridData = await fs.readFile('grid.json', 'utf8');
    grid = JSON.parse(gridData);
    const userData = await fs.readFile('user_pixels.json', 'utf8');
    userPixels = JSON.parse(userData);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error('Error loading data:', error);
    }
  }
}

async function saveData() {
  await fs.writeFile('grid.json', JSON.stringify(grid));
  await fs.writeFile('user_pixels.json', JSON.stringify(userPixels));
}

function generatePixelColor(x, y, claimed) {
  if (claimed) {
    const r = Math.sin(0.3 * x) * 127 + 128;
    const g = Math.sin(0.3 * y) * 127 + 128;
    const b = Math.sin(0.3 * (x + y)) * 127 + 128;
    return Jimp.rgbaToInt(r, g, b, 255);
  } else {
    const value = Math.sin(0.1 * (x + y)) * 30 + 225;
    return Jimp.rgbaToInt(value, value, value, 255);
  }
}

async function generateImage(newPixelX, newPixelY) {
  const width = 1200;
  const height = 630;
  const image = new Jimp(width, height, 0xFFFFFFFF); // White background

  const scaleFactor = width / GRID_SIZE;
  const scaledTokenSize = Math.floor(TOKEN_SIZE * scaleFactor);

  for (let y = 0; y < GRID_SIZE; y += TOKEN_SIZE) {
    for (let x = 0; x < GRID_SIZE; x += TOKEN_SIZE) {
      const color = generatePixelColor(x, y, grid[y][x] !== null);
      const scaledX = Math.floor(x * scaleFactor);
      const scaledY = Math.floor(y * scaleFactor);
      image.scanQuiet(scaledX, scaledY, scaledTokenSize, scaledTokenSize, function(x, y, idx) {
        this.bitmap.data.writeUInt32BE(color, idx);
      });
    }
  }

  if (newPixelX !== null && newPixelY !== null) {
    const highlightColor = Jimp.rgbaToInt(255, 255, 0, 128); // Semi-transparent yellow
    const scaledX = Math.floor(newPixelX * scaleFactor);
    const scaledY = Math.floor(newPixelY * scaleFactor);
    image.scanQuiet(scaledX, scaledY, scaledTokenSize, scaledTokenSize, function(x, y, idx) {
      const baseColor = this.bitmap.data.readUInt32BE(idx);
      const blendedColor = Jimp.blend(baseColor, highlightColor);
      this.bitmap.data.writeUInt32BE(blendedColor, idx);
    });
  }

  const font = await Jimp.loadFont(Jimp.FONT_SANS_16_BLACK);
  image.print(font, 10, 10, 'Million Pixel Frame');

  return await image.getBufferAsync(Jimp.MIME_PNG);
}

async function verifyFarcasterMessage(trustedData, untrustedData) {
  try {
    const client = getSSLHubRpcClient("nemes.farcaster.xyz:2283");
    const message = Message.decode(Buffer.from(trustedData.messageBytes, 'base64'));
    const result = await client.validateMessage(message);
    return result.isOk() && result.value.valid;
  } catch (error) {
    console.error('Error verifying Farcaster message:', error);
    return false;
  }
}

app.get('/', (req, res) => {
    const baseUrl = process.env.BASE_URL || `http://localhost:${port}`;
  
    const html = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Million Token Frame</title>
        <meta property="fc:frame" content="vNext">
        <meta property="fc:frame:image" content="${baseUrl}/frame-image">
        <meta property="fc:frame:image:aspect_ratio" content="1.91:1">
        <meta property="fc:frame:button:1" content="Claim Pixel">
        <meta property="fc:frame:post_url" content="${baseUrl}/api/frame">
      </head>
      <body>
        <h1>Million Token Frame</h1>
        <img src="/frame-image" alt="Million Token Frame" onerror="this.onerror=null; this.src='public/fallback-image.png'; console.error('Error loading frame image');">
        <p><a href="/dashboard">View Dashboard</a></p>
      </body>
      </html>
    `;
    res.send(html);
  });

app.get('/dashboard', (req, res) => {
  res.send(`
    <h1>User Dashboard</h1>
    <p>Enter your Farcaster ID to view your pixels:</p>
    <input type="text" id="fidInput" placeholder="Enter your FID">
    <button onclick="viewPixels()">View My Pixels</button>
    <div id="pixelInfo"></div>
    <script>
      function viewPixels() {
        const fid = document.getElementById('fidInput').value;
        fetch('/api/user-pixels?fid=' + fid)
          .then(response => response.json())
          .then(data => {
            const pixelInfo = document.getElementById('pixelInfo');
            if (data.pixels.length > 0) {
              pixelInfo.innerHTML = '<h2>Your Pixels:</h2>' +
                data.pixels.map(p => '<p>Position: (' + p.x + ', ' + p.y + ')</p>').join('');
            } else {
              pixelInfo.innerHTML = '<p>You haven\'t claimed any pixels yet.</p>';
            }
          });
      }
    </script>
  `);
});

app.get('/api/user-pixels', (req, res) => {
  const { fid } = req.query;
  const pixels = userPixels[fid] || [];
  res.json({ pixels });
});

app.get('/frame-image', async (req, res) => {
  try {
    const image = await generateImage(null, null);
    res.contentType('image/png');
    res.send(image);
  } catch (error) {
    console.error('Error generating image:', error);
    res.status(500).send('Error generating image');
  }
});

app.post('/api/frame', async (req, res) => {
  const { trustedData, untrustedData } = req.body;

  if (!(await verifyFarcasterMessage(trustedData, untrustedData))) {
    return res.status(400).json({ error: 'Invalid Farcaster signature' });
  }

  const fid = untrustedData.fid;

  let claimed = false;
  let claimedPosition = null;

  for (let y = 0; y < GRID_SIZE && !claimed; y += TOKEN_SIZE) {
    for (let x = 0; x < GRID_SIZE && !claimed; x += TOKEN_SIZE) {
      if (!grid[y][x]) {
        grid[y][x] = { fid };
        claimed = true;
        claimedPosition = { x, y };
        break;
      }
    }
  }

  if (claimed) {
    if (!userPixels[fid]) {
      userPixels[fid] = [];
    }
    userPixels[fid].push(claimedPosition);
    await saveData();
  }

  const image = await generateImage(claimedPosition?.x, claimedPosition?.y);

  res.json({
    frames: [
      {
        image: `data:image/png;base64,${image.toString('base64')}`,
        buttons: [{ label: claimed ? "Pixel Claimed!" : "Claim Pixel" }]
      }
    ],
    text: claimed 
      ? `You claimed a pixel at (${claimedPosition.x}, ${claimedPosition.y})! Check the dashboard to see all your pixels.`
      : "Sorry, no pixels available. Try again later!"
  });
});

loadData().then(() => {
  app.listen(port, () => {
    console.log(`Million Token Frame app listening at http://localhost:${port}`);
  });
});
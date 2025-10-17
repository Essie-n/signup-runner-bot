const express = require('express');
const bodyParser = require('body-parser');
const { chromium } = require('playwright');

const app = express();
app.use(bodyParser.json());

// ✅ Health check route (optional but useful)
app.get('/', (req, res) => {
  res.send('Bot is running 🚀');
});

// 📝 Signup route
app.post('/signup', async (req, res) => {
  const { url, email, password, fields } = req.body;

  // Basic validation
  if (!url || !url.startsWith('http')) {
    return res.status(400).json({ ok: false, message: 'Invalid URL' });
  }

  console.log(`⏳ Starting signup for: ${url}`);

  try {
    // ✅ Launch Chromium in headless mode without sandbox
    const browser = await chromium.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      headless: true,
    });

    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Example — fill email and password if inputs exist
    if (await page.$('input[type="email"]')) {
      await page.fill('input[type="email"]', email);
    }

    if (await page.$('input[type="password"]')) {
      await page.fill('input[type="password"]', password);
    }

    // ✅ Loop through dynamic fields
    if (fields && typeof fields === 'object') {
      for (const selector of Object.keys(fields)) {
        if (await page.$(selector)) {
          await page.fill(selector, fields[selector]);
        }
      }
    }

    // ✅ Attempt to submit (you can adjust this selector)
    const submitButton = await page.$('button[type="submit"], input[type="submit"]');
    if (submitButton) {
      await submitButton.click();
    }

    await page.waitForTimeout(3000); // small buffer for response
    await browser.close();

    console.log(`✅ Signup attempted for: ${url}`);
    return res.json({ ok: true, verified: false });

  } catch (error) {
    console.error(`❌ Signup failed: ${error.message}`);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Bot server running on port ${PORT}`);
});

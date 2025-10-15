import express from "express";
import dotenv from "dotenv";
import { chromium } from "playwright";
import axios from "axios";
import Imap from "imap-simple";
import { simpleParser } from "mailparser";
import { faker } from "@faker-js/faker";

dotenv.config();
const app = express();
app.use(express.json({ limit: "1mb" }));

const TWO_CAPTCHA_KEY = process.env.TWO_CAPTCHA_KEY;
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

async function solveRecaptcha(sitekey, pageurl){
  const start = await axios.get("http://2captcha.com/in.php", {
    params: { key: TWO_CAPTCHA_KEY, method: "userrecaptcha", googlekey: sitekey, pageurl, json: 1 }
  });
  if(start.data.status !== 1) throw new Error("2captcha in.php failed: " + start.data.request);
  const id = start.data.request;
  for(let i=0;i<40;i++){
    await sleep(5000);
    const r = await axios.get("http://2captcha.com/res.php", {
      params: { key: TWO_CAPTCHA_KEY, action: "get", id, json: 1 }
    });
    if(r.data.status === 1) return r.data.request;
    if(r.data.request !== "CAPCHA_NOT_READY") throw new Error("2captcha res err: " + r.data.request);
  }
  throw new Error("2captcha timeout");
}

function randomValue(token){
  switch(token){
    case "name": return faker.person.fullName();
    case "firstname": return faker.person.firstName();
    case "lastname": return faker.person.lastName();
    case "address": return faker.location.streetAddress();
    case "city": return faker.location.city();
    case "postcode": return faker.location.zipCode();
    case "company": return faker.company.name();
    case "jobTitle": return faker.person.jobTitle();
    default: return faker.person.fullName();
  }
}

async function fetchVerifyLink(timeoutMs=60000){
  const config = {
    imap: {
      user: process.env.EMAIL_USER,
      password: process.env.EMAIL_PASS,
      host: process.env.EMAIL_HOST,
      port: parseInt(process.env.EMAIL_PORT || "993", 10),
      tls: true,
      authTimeout: 30000
    }
  };
  const start = Date.now();
  const conn = await Imap.connect(config);
  await conn.openBox("INBOX");
  try {
    while(Date.now()-start < timeoutMs){
      const msgs = await conn.search(["UNSEEN"], { bodies: ["HEADER", "TEXT"], markSeen: true });
      for(const m of msgs){
        const part = m.parts.find(p => p.which === "TEXT");
        const body = part?.body || "";
        const header = m.parts.find(p => p.which === "HEADER")?.body || {};
        const subject = (header.subject || []).join(" ");
        if(/verify|confirm|activate|validation/i.test(subject + body)){
          const match = String(body).match(/https?:\/\/[^\s'"<>]+/);
          if(match) { await conn.end(); return match[0]; }
        }
      }
      await sleep(5000);
    }
  } finally {
    try { await conn.end(); } catch {}
  }
  return null;
}

app.post("/signup", async (req, res) => {
  const { url, fields = {}, email, password } = req.body;
  if(!url) return res.status(400).json({ ok:false, error:"Missing url" });
  if(!process.env.TWO_CAPTCHA_KEY) return res.status(400).json({ ok:false, error:"Missing TWO_CAPTCHA_KEY" });

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

    // Fill known fields
    for(const [selector,val] of Object.entries(fields)){
      const value = String(val).startsWith("RANDOM:") ? randomValue(String(val).split(":")[1]) : val;
      try { await page.fill(selector, String(value)); } catch {}
    }

    // Email/password fallback
    if(email){
      for(const sel of ['input[name="email"]','input[type="email"]']) {
        try { await page.fill(sel, email); break; } catch {}
      }
    }
    if(password){
      for(const sel of ['input[name="password"]','input[type="password"]']) {
        try { await page.fill(sel, password); break; } catch {}
      }
    }

    // CAPTCHA detection
    const iframe = await page.$('iframe[src*="recaptcha"], iframe[src*="google.com/recaptcha"]');
    if(iframe){
      let sitekey = null;
      const div = await page.$("div.g-recaptcha");
      if(div) sitekey = await div.getAttribute("data-sitekey");
      if(!sitekey){
        const src = await iframe.getAttribute("src");
        const m = src && src.match(/[?&]k=([^&]+)/);
        if(m) sitekey = m[1];
      }
      if(!sitekey) throw new Error("Could not extract sitekey");
      const token = await solveRecaptcha(sitekey, page.url());
      await page.evaluate((tok)=>{
        let el = document.querySelector("#g-recaptcha-response");
        if(!el){
          el = document.createElement("textarea");
          el.id = "g-recaptcha-response";
          el.name = "g-recaptcha-response";
          el.style.display = "none";
          document.body.appendChild(el);
        }
        el.value = tok;
      }, token);
    }

    const clicked = await page.click('button[type="submit"], input[type="submit"]').catch(()=>false);
    if(!clicked){
      await page.evaluate(()=>{ const f=document.querySelector("form"); if(f) f.submit(); });
    }

    await page.waitForLoadState("networkidle",{ timeout: 15000 }).catch(()=>{});
    await page.screenshot({ path: "signup-result.png", fullPage: true });

    const verifyLink = await fetchVerifyLink(parseInt(process.env.VERIFY_TIMEOUT_MS || "60000",10));
    if(verifyLink){
      const p2 = await ctx.newPage();
      await p2.goto(verifyLink, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(()=>{});
      await p2.close();
    }

    await browser.close();
    return res.json({ ok:true, verified: !!verifyLink });
  } catch (e){
    await browser.close();
    return res.status(500).json({ ok:false, error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log("Runner up on :" + PORT));

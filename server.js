import 'dotenv/config'
import express from 'express'
import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'
import { initializeApp } from 'firebase/app'
import { getDatabase, ref, push, get } from 'firebase/database'
import path from 'path'
import { fileURLToPath } from 'url'

const app = express()
app.use(express.json())

// ================= HELPERS =================
function sleep(ms){
  return new Promise(resolve => setTimeout(resolve, ms))
}

function parseFlood(err){
  const msg = err?.message || ""
  const match = msg.match(/FLOOD_WAIT_(\d+)/)
  return match ? Number(match[1]) : null
}

// ================= FIREBASE =================
if(
  !process.env.FIREBASE_API_KEY ||
  !process.env.FIREBASE_AUTH_DOMAIN ||
  !process.env.FIREBASE_DB_URL
){
  throw new Error("Missing Firebase env variables")
}

initializeApp({
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  databaseURL: process.env.FIREBASE_DB_URL
})

const db = getDatabase()

// ================= LOAD ACCOUNTS =================
const accounts = []

let i = 1
while(process.env[`TG_ACCOUNT_${i}_PHONE`]){
  const api_id = Number(process.env[`TG_ACCOUNT_${i}_API_ID`])
  const api_hash = process.env[`TG_ACCOUNT_${i}_API_HASH`]
  const session = process.env[`TG_ACCOUNT_${i}_SESSION`]
  const phone = process.env[`TG_ACCOUNT_${i}_PHONE`]

  if(api_id && api_hash && session){
    accounts.push({
      id: `TG_ACCOUNT_${i}`,
      phone,
      api_id,
      api_hash,
      session,
      status: "active",
      floodWaitUntil: 0,
      lastUsed: 0
    })
  }

  i++
}

// ================= ACCOUNT PICKER =================
function getAvailableAccount(){
  const now = Date.now()

  const valid = accounts.filter(a =>
    a.status === "active" &&
    (!a.floodWaitUntil || a.floodWaitUntil < now)
  )

  if(!valid.length) return null

  valid.sort((a,b) => a.lastUsed - b.lastUsed)

  const acc = valid[0]
  acc.lastUsed = Date.now()

  return acc
}

// ================= TELEGRAM CLIENT =================
async function getClient(account){
  const client = new TelegramClient(
    new StringSession(account.session),
    account.api_id,
    account.api_hash,
    {
      connectionRetries: 2,
      autoReconnect: false
    }
  )

  try{
    await client.connect()
    await client.getMe()
    return client
  }catch(err){
    const wait = parseFlood(err)

    if(wait){
      account.floodWaitUntil = Date.now() + wait * 1000
    }else{
      account.status = "error"
    }

    try{ await client.disconnect() }catch{}
    return null
  }
}

// ================= ROUTES =================

// HISTORY
app.get('/history', async(req,res)=>{
  const snap = await get(ref(db,'history'))
  res.json(snap.val() || {})
})

// SIMPLE TEST ROUTE (SAFE)
app.post('/send-test', async(req,res)=>{
  try{
    const acc = getAvailableAccount()
    if(!acc) return res.json({status:"failed", reason:"No account"})

    const client = await getClient(acc)
    if(!client) return res.json({status:"failed", reason:"Client error"})

    await client.sendMessage("me", {
      message: "Test OK " + new Date().toISOString()
    })

    await client.disconnect()

    return res.json({status:"success"})
  }catch(err){
    return res.json({status:"failed", reason: err.message})
  }
})

// ================= FRONTEND =================
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

app.use(express.static(__dirname))
app.get('/', (req,res)=>{
  res.sendFile(path.join(__dirname,'index.html'))
})

// ================= START SERVER =================
const PORT = process.env.PORT || 3000
app.listen(PORT, ()=>console.log(`🚀 RUN ${PORT}`))

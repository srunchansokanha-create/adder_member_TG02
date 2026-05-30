import 'dotenv/config'
import express from 'express'
import path from 'path'
import { fileURLToPath } from 'url'

import { initializeApp } from 'firebase/app'
import { getDatabase, ref, push, get } from 'firebase/database'

import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'

const app = express()
app.use(express.json())

// ================= HELPERS =================
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

const parseFlood = (err) => {
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

// ================= ACCOUNTS =================
const accounts = []

let i = 1
while(process.env[`TG_ACCOUNT_${i}_PHONE`]){
  const api_id = Number(process.env[`TG_ACCOUNT_${i}_API_ID`])
  const api_hash = process.env[`TG_ACCOUNT_${i}_API_HASH`]
  const session = process.env[`TG_ACCOUNT_${i}_SESSION`]
  const phone = process.env[`TG_ACCOUNT_${i}_PHONE`]

  if(api_id && api_hash && session){
    accounts.push({
      id: `ACC_${i}`,
      phone,
      api_id,
      api_hash,
      session,
      status: "active",
      floodUntil: 0,
      lastUsed: 0
    })
  }

  i++
}

// ================= PICK ACCOUNT =================
function getAccount(){
  const now = Date.now()

  const valid = accounts.filter(a =>
    a.status === "active" &&
    a.floodUntil < now
  )

  if(!valid.length) return null

  valid.sort((a,b)=>a.lastUsed - b.lastUsed)

  const acc = valid[0]
  acc.lastUsed = now

  return acc
}

// ================= TELEGRAM CLIENT =================
async function getClient(acc){
  const client = new TelegramClient(
    new StringSession(acc.session),
    acc.api_id,
    acc.api_hash,
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
      acc.floodUntil = Date.now() + wait * 1000
    }else{
      acc.status = "error"
    }

    try{ await client.disconnect() }catch{}
    return null
  }
}

// ================= ROUTES =================

// HOME
app.get('/', (req,res)=>{
  res.send("Telegram Server Running 🚀")
})

// ACCOUNT STATUS (FIX 304 UI)
app.get('/account-status', (req,res)=>{
  res.set('Cache-Control','no-store')

  res.json(accounts.map(a=>({
    id: a.id,
    phone: a.phone,
    status: a.status,
    floodUntil: a.floodUntil,
    lastUsed: a.lastUsed
  })))
})

// HISTORY
app.get('/history', async(req,res)=>{
  const snap = await get(ref(db,'history'))
  res.set('Cache-Control','no-store')
  res.json(snap.val() || {})
})

// TEST MESSAGE
app.post('/send-test', async(req,res)=>{
  try{
    const acc = getAccount()
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

// PLACEHOLDER (FIX 404 ISSUE)
app.post('/add-member', (req,res)=>{
  return res.json({
    status: "disabled",
    message: "This endpoint is not enabled in this build"
  })
})

// ================= FRONTEND =================
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

app.use(express.static(__dirname))

app.listen(process.env.PORT || 3000, ()=>{
  console.log("🚀 RUN SERVER")
})

import 'dotenv/config'
import express from 'express'
import { TelegramClient, Api } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'
import { initializeApp } from 'firebase/app'
import { getDatabase, ref, push, get } from 'firebase/database'
import path from 'path'
import { fileURLToPath } from 'url'

const app = express()
app.use(express.json())

function sleep(ms){ return new Promise(r=>setTimeout(r,ms)) }

// ===== FIREBASE (ONLY HISTORY) =====
const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  databaseURL: process.env.FIREBASE_DB_URL
}

initializeApp(firebaseConfig)
const db = getDatabase()

// ================= ACCOUNTS FROM RENDER ENV ONLY =================
const accounts = []

let i = 1
while(process.env[`TG_ACCOUNT_${i}_PHONE`]){
  const api_id = Number(process.env[`TG_ACCOUNT_${i}_API_ID`])
  const api_hash = process.env[`TG_ACCOUNT_${i}_API_HASH`]
  const session = process.env[`TG_ACCOUNT_${i}_SESSION`]
  const phone = process.env[`TG_ACCOUNT_${i}_PHONE`]

  if(!api_id || !api_hash || !session){
    i++
    continue
  }

  accounts.push({
    id: `TG_ACCOUNT_${i}`,
    phone,
    api_id,
    api_hash,
    session,
    status: "active",
    floodWaitUntil: null,
    lastUsed: 0
  })

  i++
}

// ================= PICK ACCOUNT (ROUND ROBIN + SAFE) =================
function getAvailableAccount(){
  const now = Date.now()

  const valid = accounts.filter(a =>
    a.status === "active" &&
    (!a.floodWaitUntil || a.floodWaitUntil < now)
  )

  if(!valid.length) return null

  valid.sort((a,b)=>a.lastUsed - b.lastUsed)

  const acc = valid[0]
  acc.lastUsed = Date.now()

  return acc
}

// ================= TELEGRAM CLIENT (NO CACHE = SAVE RAM) =================
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

    try { await client.disconnect() } catch {}
    return null
  }
}

// ================= FLOOD PARSE =================
function parseFlood(err){
  const msg = err.message || ""
  const m = msg.match(/FLOOD_WAIT_(\d+)/)
  if(m) return Number(m[1])
  return null
}

// ================= ADD MEMBER =================
app.post('/add-member', async (req,res)=>{
  try{
    const { username, user_id, access_hash, targetGroup } = req.body

    const acc = getAvailableAccount()
    if(!acc){
      return res.json({status:"failed", reason:"No account"})
    }

    const client = await getClient(acc)
    if(!client){
      return res.json({status:"failed", reason:"Client error"})
    }

    let group
    try{
      group = await client.getEntity(targetGroup)
    }catch{
      await client.disconnect()
      return res.json({status:"failed", reason:"Invalid group"})
    }

    let user
    try{
      if(username){
        user = await client.getEntity(username)
      }else{
        user = new Api.InputUser({
          userId: user_id,
          accessHash: BigInt(access_hash)
        })
      }
    }catch{
      await client.disconnect()
      return res.json({status:"skipped", reason:"User not found"})
    }

    try{
      await client.invoke(new Api.channels.InviteToChannel({
        channel: group,
        users: [user]
      }))
    }catch(err){

      const wait = parseFlood(err)
      if(wait){
        acc.floodWaitUntil = Date.now() + wait * 1000
        await client.disconnect()

        return res.json({
          status:"floodwait",
          reason:`${wait}s`
        })
      }

      await client.disconnect()
      return res.json({status:"failed", reason:err.message})
    }

    await sleep(4000)
    await client.disconnect()

    // ================= HISTORY ONLY =================
    await push(ref(db,'history'),{
      username: username || user_id,
      user_id,
      status:"success",
      accountUsed: acc.phone,
      timestamp: Date.now()
    })

    return res.json({status:"success"})

  }catch(err){
    return res.json({status:"failed", reason:err.message})
  }
})

// ================= HISTORY =================
app.get('/history', async(req,res)=>{
  const snap = await get(ref(db,'history'))
  res.json(snap.val() || {})
})

// ================= FRONTEND =================
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

app.use(express.static(__dirname))
app.get('/', (req,res)=>res.sendFile(path.join(__dirname,'index.html')))

const PORT = process.env.PORT || 3000
app.listen(PORT, ()=>console.log(`🚀 RUN ${PORT}`))

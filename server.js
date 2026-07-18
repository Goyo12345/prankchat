const http = require('http')
const { Server } = require('socket.io')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const os = require('os')

// L'URL publique de ton serveur Railway (sert à construire les liens vidéo)
const SERVER_URL = 'https://prankchat-production.up.railway.app'

// Taille max acceptée pour une vidéo envoyée (60 Mo). Au-delà, on refuse.
const MAX_UPLOAD = 60 * 1024 * 1024

// Les vidéos sont écrites sur le DISQUE (plus dans la RAM) le temps qu'OBS et
// l'ami les lisent, puis supprimées. Ça évite de saturer la mémoire du serveur.
const VIDEO_DIR = path.join(os.tmpdir(), 'prankchat_videos')

// Au démarrage : on crée le dossier et on efface d'éventuelles vidéos restantes.
try {
  fs.mkdirSync(VIDEO_DIR, { recursive: true })
  for (const f of fs.readdirSync(VIDEO_DIR)) {
    fs.unlinkSync(path.join(VIDEO_DIR, f))
  }
} catch (e) {
  console.error('Erreur préparation dossier vidéos:', e)
}

// Un identifiant de vidéo valide ressemble à "video_1699999999999.mp4".
// On le vérifie pour empêcher qu'on lise un autre fichier du serveur (sécurité).
function safeVideoId(id) {
  return /^video_\d+\.mp4$/.test(id) ? id : null
}

// --- Abonnements : on interroge Supabase avec la clé SECRÈTE (service_role) ---
// Les clés viennent des variables d'environnement de Railway (jamais dans le code).
const { createClient } = require('@supabase/supabase-js')
let supabaseAdmin = null
if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
  supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
} else {
  console.warn('⚠️ Supabase non configuré (SUPABASE_URL / SUPABASE_SERVICE_KEY manquants dans Railway).')
}

// Vérifie si le porteur de ce jeton (access token Supabase) a un abonnement actif.
async function isSubscribed(accessToken) {
  if (!supabaseAdmin || !accessToken) return false
  try {
    const { data: u, error: e1 } = await supabaseAdmin.auth.getUser(accessToken)
    if (e1 || !u || !u.user) return false
    const { data, error } = await supabaseAdmin
      .from('subscriptions')
      .select('status, current_period_end')
      .eq('user_id', u.user.id)
      .single()
    if (error || !data || data.status !== 'active') return false
    if (data.current_period_end && new Date(data.current_period_end) < new Date()) return false
    return true
  } catch (e) {
    console.error('Erreur vérif abonnement:', e)
    return false
  }
}

// Renvoie l'identifiant de l'utilisateur ET s'il est abonné, en UN SEUL appel.
// (Utilisé au moment de rejoindre une room : on a besoin de l'userId pour compter
//  les pranks gratuits du jour, en plus de savoir s'il est abonné.)
async function getAccess(accessToken) {
  if (!supabaseAdmin || !accessToken) return { userId: null, subscribed: false }
  try {
    const { data: u, error: e1 } = await supabaseAdmin.auth.getUser(accessToken)
    if (e1 || !u || !u.user) return { userId: null, subscribed: false }
    const userId = u.user.id
    const { data, error } = await supabaseAdmin
      .from('subscriptions')
      .select('status, current_period_end')
      .eq('user_id', userId)
      .single()
    let subscribed = false
    if (!error && data && data.status === 'active') {
      subscribed = !(data.current_period_end && new Date(data.current_period_end) < new Date())
    }
    return { userId, subscribed }
  } catch (e) {
    console.error('Erreur vérif accès:', e)
    return { userId: null, subscribed: false }
  }
}

// --- Stripe : page de paiement (Checkout) + webhook qui active l'abonnement ---
const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID || 'price_1Tt8QN2FMWAw3IEjWY4r1rHB'
let stripe = null
if (process.env.STRIPE_SECRET_KEY) {
  stripe = require('stripe')(process.env.STRIPE_SECRET_KEY)
} else {
  console.warn('⚠️ Stripe non configuré (STRIPE_SECRET_KEY manquant dans Railway).')
}

// Crée une page de paiement Stripe pour l'utilisateur connecté, renvoie son URL.
async function createCheckout(accessToken) {
  if (!stripe || !supabaseAdmin || !accessToken) return null
  const { data: u, error } = await supabaseAdmin.auth.getUser(accessToken)
  if (error || !u || !u.user) return null
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
    client_reference_id: u.user.id,
    customer_email: u.user.email,
    success_url: `${SERVER_URL}/paiement-ok`,
    cancel_url: `${SERVER_URL}/paiement-annule`
  })
  return session.url
}

// Crée un lien vers le "portail client" Stripe (voir / modifier / ANNULER l'abo).
async function createPortal(accessToken) {
  if (!stripe || !supabaseAdmin || !accessToken) return null
  const { data: u, error } = await supabaseAdmin.auth.getUser(accessToken)
  if (error || !u || !u.user) return null
  const { data, error: e2 } = await supabaseAdmin
    .from('subscriptions')
    .select('stripe_customer_id')
    .eq('user_id', u.user.id)
    .single()
  if (e2 || !data || !data.stripe_customer_id) return null
  const session = await stripe.billingPortal.sessions.create({
    customer: data.stripe_customer_id,
    return_url: `${SERVER_URL}/portail-retour`
  })
  return session.url
}

// Reçoit les événements Stripe et met à jour le statut d'abonnement en base.
async function handleStripeEvent(event) {
  if (!supabaseAdmin) return

  if (event.type === 'checkout.session.completed') {
    const s = event.data.object
    let periodEnd = null
    if (s.subscription) {
      const sub = await stripe.subscriptions.retrieve(s.subscription)
      if (sub.current_period_end) periodEnd = new Date(sub.current_period_end * 1000).toISOString()
    }
    await supabaseAdmin.from('subscriptions').update({
      status: 'active',
      stripe_customer_id: s.customer,
      current_period_end: periodEnd,
      updated_at: new Date().toISOString()
    }).eq('user_id', s.client_reference_id)
    console.log('Abonnement activé pour', s.client_reference_id)

  } else if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
    const sub = event.data.object
    let ourStatus = 'canceled'
    if (event.type !== 'customer.subscription.deleted') {
      if (sub.status === 'active' || sub.status === 'trialing') ourStatus = 'active'
      else if (sub.status === 'past_due' || sub.status === 'unpaid') ourStatus = 'past_due'
    }
    const periodEnd = sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null
    await supabaseAdmin.from('subscriptions').update({
      status: ourStatus,
      current_period_end: periodEnd,
      updated_at: new Date().toISOString()
    }).eq('stripe_customer_id', sub.customer)
    console.log('Abonnement mis à jour (', ourStatus, ') pour client', sub.customer)
  }
}

// Pour chaque personne connectée : dans quelle room elle est + son jeton secret.
// (En mémoire : ça se recrée tout seul quand les gens se reconnectent.)
const socketInfo = {}

// Petit anti-spam : on retient les horaires des dernières actions par clé.
const actionTimes = {}
function allow(key, maxCount, windowMs) {
  const now = Date.now()
  actionTimes[key] = (actionTimes[key] || []).filter((t) => now - t < windowMs)
  if (actionTimes[key].length >= maxCount) return false
  actionTimes[key].push(now)
  return true
}

// --- Freemium : 5 pranks gratuits par jour, puis abonnement pour l'illimité ---
const FREE_DAILY_LIMIT = 5
// userId -> { date: 'AAAA-MM-JJ', count: n }. En MÉMOIRE : le compteur se remet à
// zéro si le serveur Railway redémarre (acceptable au lancement ; on pourra le
// passer en base Supabase plus tard si des gens en abusent).
const dailyCount = {}

function todayStr() {
  return new Date().toISOString().slice(0, 10)
}

// Combien de pranks gratuits il reste aujourd'hui pour cet utilisateur.
function freeRemaining(userId) {
  if (!userId) return 0
  const rec = dailyCount[userId]
  if (!rec || rec.date !== todayStr()) return FREE_DAILY_LIMIT
  return Math.max(0, FREE_DAILY_LIMIT - rec.count)
}

// Consomme 1 prank gratuit. Renvoie true si OK, false si la limite est atteinte.
function consumeFree(userId) {
  if (!userId) return false
  const today = todayStr()
  const rec = dailyCount[userId]
  if (!rec || rec.date !== today) {
    dailyCount[userId] = { date: today, count: 1 }
    return true
  }
  if (rec.count >= FREE_DAILY_LIMIT) return false
  rec.count++
  return true
}

const server = http.createServer((req, res) => {
  // 0) Réponse aux "preflight" CORS (le navigateur vérifie avant un appel cross-origine)
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'authorization, content-type'
    })
    res.end()
    return
  }

  // L'app demande : "l'utilisateur connecté a-t-il un abonnement actif ?"
  if (req.url === '/access') {
    const auth = req.headers['authorization'] || ''
    const token = auth.replace('Bearer ', '')
    isSubscribed(token).then((subscribed) => {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      })
      res.end(JSON.stringify({ subscribed }))
    })
    return
  }

  // Inscription : le serveur crée un compte DÉJÀ confirmé (via la clé service_role),
  // ce qui évite tout le casse-tête de la confirmation par email.
  if (req.method === 'POST' && req.url === '/signup') {
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim()
    if (!allow(`signup_${ip}`, 5, 60000)) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
      res.end(JSON.stringify({ error: 'Trop de tentatives, réessaie dans une minute.' }))
      return
    }
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', async () => {
      let body = {}
      try { body = JSON.parse(Buffer.concat(chunks).toString()) } catch (e) {}
      const email = (body.email || '').trim()
      const password = body.password || ''
      const cors = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      if (!supabaseAdmin) {
        res.writeHead(500, cors); res.end(JSON.stringify({ error: 'Serveur non configuré' })); return
      }
      if (!email || password.length < 6) {
        res.writeHead(400, cors); res.end(JSON.stringify({ error: 'Email ou mot de passe invalide (min. 6 caractères).' })); return
      }
      const { error } = await supabaseAdmin.auth.admin.createUser({ email, password, email_confirm: true })
      if (error) {
        res.writeHead(400, cors); res.end(JSON.stringify({ error: error.message })); return
      }
      res.writeHead(200, cors); res.end(JSON.stringify({ ok: true }))
    })
    return
  }

  // L'app demande à démarrer un paiement -> on renvoie l'URL de la page Stripe
  if (req.method === 'POST' && req.url === '/create-checkout') {
    const auth = req.headers['authorization'] || ''
    const token = auth.replace('Bearer ', '')
    createCheckout(token).then((url) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
      res.end(JSON.stringify({ url }))
    }).catch((e) => {
      console.error('Erreur create-checkout:', e)
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
      res.end(JSON.stringify({ url: null }))
    })
    return
  }

  // L'app demande le lien du portail client Stripe (gérer / annuler l'abo)
  if (req.method === 'POST' && req.url === '/portal') {
    const auth = req.headers['authorization'] || ''
    const token = auth.replace('Bearer ', '')
    createPortal(token).then((url) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
      res.end(JSON.stringify({ url }))
    }).catch((e) => {
      console.error('Erreur portal:', e)
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
      res.end(JSON.stringify({ url: null }))
    })
    return
  }

  // Stripe nous prévient (paiement réussi, renouvellement, annulation...)
  if (req.method === 'POST' && req.url === '/webhook') {
    if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
      res.writeHead(500)
      res.end('stripe non configuré')
      return
    }
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      let event
      try {
        event = stripe.webhooks.constructEvent(
          Buffer.concat(chunks),
          req.headers['stripe-signature'],
          process.env.STRIPE_WEBHOOK_SECRET
        )
      } catch (e) {
        console.error('Webhook signature invalide:', e.message)
        res.writeHead(400)
        res.end('signature invalide')
        return
      }
      handleStripeEvent(event)
        .then(() => { res.writeHead(200); res.end('ok') })
        .catch((e) => { console.error('Erreur webhook:', e); res.writeHead(200); res.end('ok') })
    })
    return
  }

  // Petites pages affichées dans le navigateur après le paiement
  if (req.url === '/paiement-ok') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end('<h1 style="font-family:sans-serif;text-align:center;margin-top:20vh">✅ Paiement réussi !<br>Retourne dans PrankChat et clique « J\'ai payé ».</h1>')
    return
  }
  if (req.url === '/paiement-annule') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end('<h1 style="font-family:sans-serif;text-align:center;margin-top:20vh">Paiement annulé.<br>Tu peux fermer cette page.</h1>')
    return
  }
  if (req.url === '/portail-retour') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end('<h1 style="font-family:sans-serif;text-align:center;margin-top:20vh">✅ C\'est noté !<br>Tu peux fermer cette page et retourner dans PrankChat.</h1>')
    return
  }

  // 1) L'app de l'expéditeur nous envoie une vidéo déjà téléchargée sur son PC
  if (req.method === 'POST' && req.url.startsWith('/upload')) {
    const urlObj = new URL(req.url, 'http://localhost')
    const room = urlObj.searchParams.get('room')
    const caption = urlObj.searchParams.get('caption') || ''
    const senderId = urlObj.searchParams.get('senderId') || ''
    const token = urlObj.searchParams.get('token') || ''
    const duration = urlObj.searchParams.get('duration') || ''
    const position = urlObj.searchParams.get('position') || 'center'
    const size = urlObj.searchParams.get('size') || 'medium'

    // Vérif 1 : l'expéditeur doit être une personne réellement connectée à cette
    // room, avec le bon jeton secret. Sinon on refuse (ferme la route aux inconnus).
    const info = socketInfo[senderId]
    if (!room || !info || info.room !== room || info.token !== token) {
      res.writeHead(403)
      res.end('non autorise')
      return
    }

    // Vérif 1bis (freemium) : abonné = illimité ; sinon la vidéo compte dans les
    // 5 pranks gratuits du jour. On bloque seulement si le quota est déjà épuisé.
    // (On décomptera vraiment le prank une fois la vidéo bien reçue, plus bas.)
    if (!info.subscribed && freeRemaining(info.userId) <= 0) {
      res.writeHead(402)
      res.end('limite atteinte')
      return
    }

    // Vérif 2 : pas plus de 10 vidéos par minute par expéditeur (anti-spam).
    if (!allow(`upload_${senderId}`, 10, 60000)) {
      res.writeHead(429)
      res.end('trop de vidéos, ralentis')
      return
    }

    // On écrit la vidéo directement sur le disque, au fil de l'eau (sans jamais
    // charger le fichier entier en mémoire), en refusant si ça dépasse le max.
    const videoId = `video_${Date.now()}.mp4`
    const filePath = path.join(VIDEO_DIR, videoId)
    const writeStream = fs.createWriteStream(filePath)
    let total = 0
    let aborted = false

    function abort(code, message) {
      if (aborted) return
      aborted = true
      req.destroy()
      writeStream.destroy()
      fs.unlink(filePath, () => {})
      res.writeHead(code)
      res.end(message)
    }

    req.on('data', (chunk) => {
      total += chunk.length
      if (total > MAX_UPLOAD) abort(413, 'vidéo trop lourde')
    })
    req.on('error', () => abort(400, 'erreur reception'))
    writeStream.on('error', () => abort(500, 'erreur ecriture'))
    req.pipe(writeStream)

    writeStream.on('finish', () => {
      if (aborted) return
      console.log(`Vidéo reçue (${(total / 1024 / 1024).toFixed(1)} Mo) -> ${videoId}`)

      // On supprime le fichier du disque après 2 minutes.
      setTimeout(() => {
        fs.unlink(filePath, () => {})
        console.log('Vidéo supprimée du disque:', videoId)
      }, 120000)

      // On envoie le lien direct .mp4 à toute la room (OBS + ami),
      // sauf à l'expéditeur qui l'affiche déjà lui-même.
      const videoUrl = `${SERVER_URL}/video/${videoId}`
      io.to(room).except(senderId).emit('receive-prank', {
        imageUrl: videoUrl,
        caption: caption,
        duration: duration ? parseInt(duration, 10) : undefined,
        position: position,
        size: size
      })

      // Freemium : la vidéo est bien partie -> on décompte 1 prank du jour et on
      // informe l'expéditeur de son quota restant (pour l'afficher dans l'app).
      if (!info.subscribed) {
        consumeFree(info.userId)
        io.to(senderId).emit('quota', { subscribed: false, remaining: freeRemaining(info.userId) })
      }

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ videoUrl }))
    })
    return
  }

  // 2) OBS (ou l'ami) lit une vidéo depuis le disque
  if (req.url.startsWith('/video/')) {
    const videoId = safeVideoId(req.url.replace('/video/', ''))
    if (!videoId) {
      res.writeHead(404)
      res.end('Not found')
      return
    }

    const filePath = path.join(VIDEO_DIR, videoId)
    fs.stat(filePath, (err, stats) => {
      if (err) {
        res.writeHead(404)
        res.end('Not found')
        return
      }
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Length': stats.size,
        'Access-Control-Allow-Origin': '*'
      })
      // On envoie le fichier au fil de l'eau (pas chargé entièrement en RAM).
      fs.createReadStream(filePath).pipe(res)
    })
    return
  }

  // 3) La page OBS
  if (req.url === '/obs' || req.url.startsWith('/obs?')) {
    fs.readFile(path.join(__dirname, 'obs.html'), (err, data) => {
      if (err) {
        res.writeHead(404)
        res.end('Not found')
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(data)
    })
    return
  }

  // Site vitrine : page d'accueil + CGU (sert aussi pour la validation Stripe)
  if (req.url === '/' || req.url === '/index.html') {
    fs.readFile(path.join(__dirname, 'landing.html'), (err, data) => {
      if (err) { res.writeHead(500); res.end('Erreur'); return }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(data)
    })
    return
  }
  if (req.url === '/cgu') {
    fs.readFile(path.join(__dirname, 'cgu.html'), (err, data) => {
      if (err) { res.writeHead(500); res.end('Erreur'); return }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(data)
    })
    return
  }

  res.writeHead(200)
  res.end('PrankChat server running')
})

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
})

const rooms = {}

io.on('connection', (socket) => {
  console.log('Utilisateur connecté:', socket.id)

  socket.on('join-room', async (roomCode, accessToken, callback) => {
    // Anti-devinette : max 60 tentatives de connexion par minute et par adresse,
    // pour empêcher quelqu'un d'essayer des milliers de codes à la chaîne.
    const ip = (socket.handshake.headers['x-forwarded-for'] || socket.handshake.address || '')
      .split(',')[0]
      .trim()
    if (!allow(`join_${ip}`, 60, 60000)) {
      console.log('Trop de tentatives de connexion depuis', ip)
      if (typeof callback === 'function') callback(null)
      return
    }

    // On génère un jeton secret unique pour cette personne dans cette room,
    // et on vérifie SON abonnement une seule fois (réutilisé à chaque envoi).
    const token = crypto.randomBytes(16).toString('hex')
    const { userId, subscribed } = await getAccess(accessToken)
    socketInfo[socket.id] = { room: roomCode, token: token, subscribed: subscribed, userId: userId }

    socket.join(roomCode)
    rooms[roomCode] = rooms[roomCode] || []
    rooms[roomCode].push(socket.id)
    console.log(`${socket.id} a rejoint la room: ${roomCode}`)

    socket.to(roomCode).emit('friend-connected')
    io.to(roomCode).emit('room-users', rooms[roomCode].length)

    // On indique à l'app son quota du jour : illimité si abonné, sinon X/5.
    socket.emit('quota', { subscribed: subscribed, remaining: subscribed ? null : freeRemaining(userId) })

    // On renvoie le jeton à l'app (elle le présentera pour envoyer une vidéo).
    if (typeof callback === 'function') callback(token)
  })

  // Images, GIFs et vidéos .mp4 directes : on relaie l'URL telle quelle.
  // Les liens YouTube/TikTok NE passent PAS par ici : ils sont téléchargés
  // sur le PC de l'expéditeur puis envoyés via /upload (voir plus haut).
  socket.on('send-prank', (data) => {
    const info = socketInfo[socket.id]
    // On n'accepte que si la personne est bien dans la room qu'elle vise...
    if (!info || info.room !== data.roomCode) return
    // ...et pas plus de 15 vannes par minute (anti-spam).
    if (!allow(`prank_${socket.id}`, 15, 60000)) return

    // Freemium : abonné = illimité ; sinon 5 pranks/jour, puis on propose Premium.
    if (!info.subscribed && !consumeFree(info.userId)) {
      socket.emit('limit-reached')
      return
    }

    socket.to(data.roomCode).emit('receive-prank', {
      imageUrl: data.imageUrl,
      caption: data.caption,
      duration: data.duration,
      position: data.position,
      size: data.size
    })

    // On informe l'expéditeur de son quota restant (pour l'afficher dans l'app).
    if (!info.subscribed) {
      socket.emit('quota', { subscribed: false, remaining: freeRemaining(info.userId) })
    }
  })

  socket.on('disconnect', () => {
    console.log('Utilisateur déconnecté:', socket.id)
    delete socketInfo[socket.id]
    delete actionTimes[`upload_${socket.id}`]
    delete actionTimes[`prank_${socket.id}`]
    for (const room in rooms) {
      rooms[room] = rooms[room].filter((id) => id !== socket.id)
    }
  })
})

server.listen(process.env.PORT || 3000, () => {
  console.log('Serveur PrankChat lancé sur le port', process.env.PORT || 3000)
})

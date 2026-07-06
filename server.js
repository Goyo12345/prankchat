const http = require('http')
const { Server } = require('socket.io')
const fs = require('fs')
const path = require('path')
const { exec, execSync } = require('child_process')
const os = require('os')

const ytdlpPath = path.join(os.tmpdir(), 'yt-dlp')

function setupYtdlp() {
  if (!fs.existsSync(ytdlpPath)) {
    console.log('Installation de yt-dlp...')
    const https = require('https')
    const file = fs.createWriteStream(ytdlpPath)
    
    https.get('https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp', (response) => {
      if (response.statusCode === 302 || response.statusCode === 301) {
        https.get(response.headers.location, (res) => {
          res.pipe(file)
          file.on('finish', () => {
            file.close()
            fs.chmodSync(ytdlpPath, '755')
            console.log('yt-dlp installé !')
          })
        })
      } else {
        response.pipe(file)
        file.on('finish', () => {
          file.close()
          fs.chmodSync(ytdlpPath, '755')
          console.log('yt-dlp installé !')
        })
      }
    }).on('error', (e) => {
      console.error('Erreur installation yt-dlp:', e)
    })
  } else {
    console.log('yt-dlp déjà présent')
  }
}

function isYoutubeOrTiktok(url) {
  return url.includes('youtube.com') || 
         url.includes('youtu.be') || 
         url.includes('tiktok.com')
}

function downloadVideo(url) {
  return new Promise((resolve, reject) => {
    const tmpFile = path.join(os.tmpdir(), `prankchat_${Date.now()}.mp4`)
    const cmd = `${ytdlpPath} -o "${tmpFile}" --no-playlist -f "best[ext=mp4]/best" --max-filesize 20m "${url}"`
    
    exec(cmd, (error) => {
      if (error) {
        reject(error)
        return
      }
      resolve(tmpFile)
    })
  })
}

const server = http.createServer((req, res) => {
  // Servir les vidéos temporaires
  if (req.url.startsWith('/video/')) {
    const filename = req.url.replace('/video/', '')
    const filePath = path.join(os.tmpdir(), filename)
    
    if (fs.existsSync(filePath)) {
      res.writeHead(200, { 'Content-Type': 'video/mp4' })
      const stream = fs.createReadStream(filePath)
      stream.pipe(res)
      
      // Supprimer après 30 secondes
      setTimeout(() => {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath)
          console.log('Vidéo supprimée:', filename)
        }
      }, 30000)
    } else {
      res.writeHead(404)
      res.end('Not found')
    }
  } else if (req.url === '/obs' || req.url.startsWith('/obs?')) {
    const filePath = path.join(__dirname, 'obs.html')
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404)
        res.end('Not found')
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(data)
    })
  } else {
    res.writeHead(200)
    res.end('PrankChat server running')
  }
})

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
})

const rooms = {}

io.on('connection', (socket) => {
  console.log('Utilisateur connecté:', socket.id)

  socket.on('join-room', (roomCode) => {
    socket.join(roomCode)
    rooms[roomCode] = rooms[roomCode] || []
    rooms[roomCode].push(socket.id)
    console.log(`${socket.id} a rejoint la room: ${roomCode}`)
    
    socket.to(roomCode).emit('friend-connected')
    io.to(roomCode).emit('room-users', rooms[roomCode].length)
  })

  socket.on('send-prank', async (data) => {
    if (isYoutubeOrTiktok(data.imageUrl)) {
      try {
        console.log('Téléchargement:', data.imageUrl)
        const tmpFile = await downloadVideo(data.imageUrl)
        const filename = path.basename(tmpFile)
        const videoUrl = `https://prankchat-production.up.railway.app/video/${filename}`
        
        socket.to(data.roomCode).emit('receive-prank', {
          imageUrl: videoUrl,
          caption: data.caption
        })
      } catch (e) {
        console.error('Erreur téléchargement:', e)
        socket.to(data.roomCode).emit('receive-prank', {
          imageUrl: data.imageUrl,
          caption: data.caption
        })
      }
    } else {
      socket.to(data.roomCode).emit('receive-prank', {
        imageUrl: data.imageUrl,
        caption: data.caption
      })
    }
  })

  socket.on('disconnect', () => {
    console.log('Utilisateur déconnecté:', socket.id)
    for (const room in rooms) {
      rooms[room] = rooms[room].filter(id => id !== socket.id)
    }
  })
})

setupYtdlp()

server.listen(process.env.PORT || 3000, () => {
  console.log('Serveur PrankChat lancé sur le port', process.env.PORT || 3000)
})
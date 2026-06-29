const http = require('http')
const { Server } = require('socket.io')

const server = http.createServer()
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

  socket.on('send-prank', (data) => {
    socket.to(data.roomCode).emit('receive-prank', {
      imageUrl: data.imageUrl,
      caption: data.caption
    })
  })

  socket.on('disconnect', () => {
    console.log('Utilisateur déconnecté:', socket.id)
    for (const room in rooms) {
      rooms[room] = rooms[room].filter(id => id !== socket.id)
    }
  })
})

server.listen(3000, () => {
  console.log('Serveur PrankChat lancé sur le port 3000')
})
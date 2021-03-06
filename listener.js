const Dgram = require('dgram')
const Crypto = require('crypto')
const EventEmitter  = require('events')

const Connection = require('./connection')
const InetAddress = require('./utils/inet_address')
const Identifiers = require('./protocol/identifiers')
const UnconnectedPing = require('./protocol/unconnected_ping')
const UnconnectedPong = require('./protocol/unconnected_pong')
const OpenConnectionRequest1 = require('./protocol/open_connection_request_1')
const OpenConnectionReply1 = require('./protocol/open_connection_reply_1')
const OpenConnectionRequest2  = require('./protocol/open_connection_request_2')
const OpenConnectionReply2 = require('./protocol/open_connection_reply_2')
const IncompatibleProtocolVersion = require('./protocol/incompatible_protoco_version')

'use strict'

// Used if no motd is given in constructor
const DUMMY_MOTD = 'MCPE;JSRakNet;407;1.16.0;0;5;server_id;JSRakNet;Creative;'
const PROTOCOL = 10  // Minecraft related protocol 

// Raknet ticks
const RAKNET_TPS = 100
const RAKNET_TICK_LENGTH = 1 / RAKNET_TPS

// Listen to packets and then process them
class Listener extends EventEmitter {

    /** @type {number} */
    #id = Crypto.randomBytes(8).readBigInt64BE()  // Generate a signed random 64 bit GUID
    /** @type {string} */
    #name
    /** @type {Dgram.Socket} */
    #socket
    /** @type {Map<string, Connection>} */
    #connections = new Map()
    /** @type {boolean} */
    #shutdown = false 

    /**
     * Creates a packet listener on given address and port.
     * 
     * @param {string} address 
     * @param {number} port 
     * @param {string} name 
     */
    listen(address, port, name) {
        this.#socket = Dgram.createSocket({ type: 'udp4' })
        this.#name = name
        
        this.#socket.on('error', (e) => {
            throw e
        })

        this.#socket.on('listening', () => {
            console.log(`JSRakNode is now listening on ${address}:${port}`)
        })

        this.#socket.on('message', (buffer, rinfo) => {
            this.handle(buffer, rinfo)
        })

        this.#socket.bind(port, address)
        this.tick()  // tick sessions
        return this
    }

    handle(buffer, rinfo) {
        let header = buffer.readUInt8()  // Read packet header to recognize packet type

        // I have an idea for reconnection, but maybe can be fixed soon
        // using another method from session itself

        let token = `${rinfo.address}:${rinfo.port}`
        if (this.#connections.has(token)) {
            let connection = this.#connections.get(token)
            connection.receive(buffer)
        } else {
            switch(header) {
                case Identifiers.UnconnectedPing:
                    this.handleUnconnectedPing(buffer).then(buffer => {
                        this.#socket.send(buffer, 0, buffer.length, rinfo.port, rinfo.address)
                    })
                break
                case Identifiers.OpenConnectionRequest1:
                    this.handleOpenConnectionRequest1(buffer).then(buffer => {
                        this.#socket.send(buffer, 0, buffer.length, rinfo.port, rinfo.address)
                    })
                break  
                case Identifiers.OpenConnectionRequest2:
                    let address = new InetAddress(rinfo.address, rinfo.port)
                    this.handleOpenConnectionRequest2(buffer, address).then(buffer => {
                        this.#socket.send(buffer, 0, buffer.length, rinfo.port, rinfo.address)
                    })
                break      
            } 
        }
    }

    // async handlers

    async handleUnconnectedPing(buffer) {
        let decodedPacket, packet

        // Decode server packet
        decodedPacket = new UnconnectedPing()
        decodedPacket.buffer = buffer
        decodedPacket.read()

        // Check packet validity
        // To refactor
        if (!decodedPacket.valid) {
            throw new Error('Received an invalid offline message')
        }

        // Encode response
        packet = new UnconnectedPong() 
        packet.sendTimestamp = decodedPacket.sendTimeStamp
        packet.serverGUID = this.#id

        // Prepare a default server name
        // in case the user didn't give a proper one
        if (!this.#name || typeof this.#name !== 'string') {
            this.#name = DUMMY_MOTD
        }

        // Replace MOTD server id with an actual one
        let name = this.#name.split(';')
        name[6] = `${this.#id}`
        name = name.join(';')
                
        packet.serverName = name
        packet.write()

        return packet.buffer
    }

    async handleOpenConnectionRequest1(buffer) {
        let decodedPacket, packet

        // Decode server packet
        decodedPacket = new OpenConnectionRequest1()
        decodedPacket.buffer = buffer
        decodedPacket.read()

        // Check packet validity
        // To refactor
        if (!decodedPacket.valid) {
            throw new Error('Received an invalid offline message')
        }

        if (decodedPacket.protocol !== PROTOCOL) {
            packet = new IncompatibleProtocolVersion()
            packet.protocol = PROTOCOL
            packet.serverGUID = this.#id
            packet.write()
            return packet.buffer
        }

        // Encode response
        packet = new OpenConnectionReply1()
        packet.serverGUID = this.#id
        packet.mtuSize = decodedPacket.mtuSize
        packet.write()

        return packet.buffer
    }

    async handleOpenConnectionRequest2(buffer, address) {
        let decodedPacket, packet

        // Decode server packet
        decodedPacket = new OpenConnectionRequest2()
        decodedPacket.buffer = buffer
        decodedPacket.read()

        // Check packet validity
        // To refactor
        if (!decodedPacket.valid) {
            throw new Error('Received an invalid offline message')
        }

        // Encode response
        packet = new OpenConnectionReply2()
        packet.serverGUID = this.#id
        packet.mtuSize = decodedPacket.mtuSize
        packet.clientAddress = address
        packet.write()

        // Create a session
        let token = `${address.address}:${address.port}`
        let conn = new Connection(this, decodedPacket.mtuSize, address)
        this.#connections.set(token, conn)

        return packet.buffer
    }

    tick() {
        let int = setInterval(() => {
            if (!this.#shutdown) {
                for (let [_, connection]of this.#connections) {
                    connection.update(Date.now())
                }
            } else {
                clearInterval(int)
            }
        }, RAKNET_TICK_LENGTH * 1000)
    }

    /**
     * Remove a connection from all connections.
     * 
     * @param {Connection} connection 
     * @param {string} reason 
     */
    removeConnection(connection, reason) {
        let inetAddr = connection.address
        let token = `${inetAddr.address}:${inetAddr.port}`
        if (this.#connections.has(token)) {
            (this.#connections.get(token)).close()
            this.#connections.delete(token)
        }
        this.emit('closeConnection', connection.address, reason)
    }

    /**
     * Send packet buffer to the client.
     * 
     * @param {Buffer} buffer 
     * @param {string} address 
     * @param {number} port 
     */
    sendBuffer(buffer, address, port) {
        this.#socket.send(buffer, 0, buffer.length, port, address)
    }

    get socket() {
        return this.#socket
    }

    get connections() {
        return this.#connections
    }

    get name () {
        return this.#name
    }

    set name(name) {
        this.#name = name
    }

}
module.exports = Listener
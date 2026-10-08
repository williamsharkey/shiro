# frozen_string_literal: true
# Shiro: ruby.wasm is built without the socket extension (WASI preview1 has
# no sockets). These definitions let code that only loads socket-using
# libraries work (rubygems' `gem list`, net/http constants); opening a
# connection raises.
class SocketError < StandardError; end

class BasicSocket < IO
  def self.do_not_reverse_lookup = true
  def self.do_not_reverse_lookup=(_v); end
end

class Socket < BasicSocket
  AF_UNSPEC = 0
  AF_UNIX = 1
  AF_INET = 2
  AF_INET6 = 10
  PF_INET = AF_INET
  PF_INET6 = AF_INET6
  SOCK_STREAM = 1
  SOCK_DGRAM = 2
  IPPROTO_TCP = 6
  IPPROTO_UDP = 17
  SOL_SOCKET = 1
  SO_KEEPALIVE = 9
  SO_REUSEADDR = 2
  TCP_NODELAY = 1
  AI_PASSIVE = 1

  def self.unavailable = raise(Errno::ENOSYS, 'sockets are not available in this Ruby (WASI)')
  def self.tcp(*) = unavailable
  def self.unix(*) = unavailable
  def self.gethostname = 'localhost'
  def self.getaddrinfo(*) = raise(SocketError, 'getaddrinfo: sockets are not available in this Ruby (WASI)')
  def self.ip_address_list = []
  def initialize(*) = Socket.unavailable
end

class IPSocket < BasicSocket
  def self.getaddress(host) = raise(SocketError, "getaddrinfo: #{host}: sockets are not available in this Ruby (WASI)")
end

class TCPSocket < IPSocket
  def self.gethostbyname(*) = Socket.unavailable
  def initialize(*) = Socket.unavailable
end

class TCPServer < TCPSocket; end
class UDPSocket < IPSocket
  def initialize(*) = Socket.unavailable
end
class UNIXSocket < BasicSocket
  def initialize(*) = Socket.unavailable
end
class UNIXServer < UNIXSocket; end

class Addrinfo
  def self.tcp(*) = Socket.unavailable
  def self.getaddrinfo(*) = Socket.getaddrinfo
end

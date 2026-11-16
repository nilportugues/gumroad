# frozen_string_literal: true

# A local stand-in for api.stripe.com that the Ruby golden generators point the stripe gem at:
# it records every request and answers from a script.
require "socket"

# A keep-alive HTTP/1.1 server, as Net::HTTP reuses its connection between requests.
class CaptureServer
  attr_reader :port, :requests
  attr_accessor :responses

  # Machine-specific (uname, hostname, port) and deliberately different on Node, so not recorded.
  UNRECORDED_HEADERS = %w[user-agent x-stripe-client-user-agent host].freeze

  def initialize
    @server = TCPServer.new("127.0.0.1", 0)
    @port = @server.addr[1]
    @requests = []
    @responses = []
    @mutex = Mutex.new
    Thread.new { loop { socket = @server.accept; Thread.new(socket) { |s| serve(s) } } }
  end

  def serve(socket)
    loop do
      request_line = socket.gets
      break if request_line.nil?

      method, target, = request_line.split(" ")
      headers = {}
      while (line = socket.gets) && line != "\r\n"
        name, value = line.chomp.split(": ", 2)
        headers[name.downcase] = value unless UNRECORDED_HEADERS.include?(name.downcase)
      end
      body = headers["content-length"] ? socket.read(headers["content-length"].to_i) : nil
      path, query = target.split("?", 2)
      response = @mutex.synchronize do
        @requests << { "method" => method, "path" => path, "query" => query, "headers" => headers, "body" => body }
        @responses.shift || [500, {}, "no scripted response"]
      end
      status, response_headers, response_body = response
      # A scripted `[:drop]` closes the connection without answering, as a peer that goes away mid-request.
      break if status == :drop

      sleep(response_headers.delete("x-test-delay").to_f) if response_headers.key?("x-test-delay")
      head = ["HTTP/1.1 #{status} X", "Content-Length: #{response_body.bytesize}", "Connection: keep-alive"]
      response_headers.each { |name, value| head << "#{name}: #{value}" }
      socket.write(head.join("\r\n") + "\r\n\r\n" + response_body)
    end
  rescue IOError, Errno::ECONNRESET, Errno::EPIPE
    nil
  ensure
    socket.close
  end
end

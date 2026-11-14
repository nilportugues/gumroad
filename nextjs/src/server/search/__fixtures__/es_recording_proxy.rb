# frozen_string_literal: true

# Shared by the Elasticsearch golden generators: a TCP proxy between EsClient and the real
# Elasticsearch that keeps the exact request bytes and the answer of every call made while `on`.
require "net/http"
require "socket"
require "json"

REAL_ES = URI(ENV.fetch("ELASTICSEARCH_HOST"))

# --- Elasticsearch proxy ----------------------------------------------------------------------------
module EsProxy
  class << self
    attr_accessor :on
    def log = (@log ||= [])

    def start
      server = TCPServer.new("127.0.0.1", 0)
      Thread.new { loop { Thread.new(server.accept) { |socket| serve(socket) } } }
      server.addr[1]
    end

    def serve(socket)
      loop do
        line = socket.gets or break
        method, target = line.split(" ")
        headers = {}
        while (header = socket.gets) && header != "\r\n"
          key, value = header.split(": ", 2)
          headers[key.downcase] = value.strip
        end
        body = headers["content-length"] ? socket.read(headers["content-length"].to_i) : nil
        request = Net::HTTP.const_get(method.capitalize).new(target)
        request["content-type"] = headers["content-type"] if headers["content-type"]
        request.body = body
        response = Net::HTTP.start(REAL_ES.host, REAL_ES.port) { _1.request(request) }
        path, query = target.split("?", 2)
        log << { "method" => method, "path" => path, "query" => query, "body" => body, "status" => response.code.to_i, "response" => response.body.to_s } if on
        socket.write("HTTP/1.1 #{response.code} X\r\nContent-Type: application/json\r\nContent-Length: #{response.body.to_s.bytesize}\r\nConnection: close\r\n\r\n#{response.body}")
        break
      end
    ensure
      socket.close
    end
  end
end

def connect_recording_client!
  port = EsProxy.start
  Object.send(:remove_const, :EsClient)
  client = Elasticsearch::Model.client = Elasticsearch::Client.new(host: "http://127.0.0.1:#{port}", retry_on_failure: 5, transport_options: { request: { timeout: 15 } })
  Object.const_set(:EsClient, client)
  [Link, Purchase, Installment, AudienceMember, ConfirmedFollowerEvent, ProductPageView].each { _1.__elasticsearch__.client = client }
end

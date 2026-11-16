# frozen_string_literal: true

# Produces nextjs/src/server/controllers/__fixtures__/public-exceptions.golden.json: what Rails answers to a 404 (a
# RoutingError, which ApplicationController#e404 raises) for a spread of Accept headers, `format` parameters, path
# extensions, XHR and Content-Type combinations, through the full Rack stack.
#
# `production` cases run with the production exception settings (`consider_all_requests_local = false`,
# `show_exceptions = :all`), where ActionDispatch::PublicExceptions answers. `test` cases run with the test
# environment's own settings, where DebugExceptions answers every request with its HTML page, whatever the Accept header says.
#
#   RAILS_ENV=test bundle exec rails runner nextjs/scripts/golden/public-exceptions.rb   (env as in publish-scheduled-post.rb)
require "json"
require "rack/mock"

OUT = Rails.root.join("nextjs/src/server/controllers/__fixtures__/public-exceptions.golden.json")
PATH = "/nosuch/route"
PUBLIC_404 = Rails.root.join("public/404.html").read

ACCEPTS = [
  nil,
  "",
  "   ",
  "application/json",
  "  application/json  ",
  "application/json; charset=utf-8",
  "application/json;q=0.5",
  "application/json; q=0.5",
  "text/x-json",
  "application/jsonrequest",
  "application/problem+json",
  "application/json, text/html",
  "text/html, application/json",
  "application/json,text/html",
  "text/html;q=0.5, application/json",
  "application/json;q=0.5, text/html;q=0.9",
  "application/json, application/xml",
  "application/xml, application/json",
  "application/json, text/plain",
  "text/plain, application/json",
  "application/json, image/png",
  "image/png, application/json",
  "application/json, foo/bar",
  "foo/bar, application/json",
  "application/pdf, application/json",
  "text/css, application/json",
  "*/*",
  "application/json, */*",
  "*/*, application/json",
  "application/json,*/*;q=0.8",
  "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "text/*",
  "text/*, application/json",
  "application/*",
  "application/*, text/html",
  "application/xml",
  "text/xml",
  "application/x-xml",
  "text/xml, application/xml",
  "application/xml, text/xml",
  "text/xml, application/json",
  "text/xml;q=0.5, application/json;q=0.4",
  "application/json;q=0.4, text/xml;q=0.5, application/xml;q=0.3",
  "application/xml;q=0.3, text/xml;q=0.9",
  "application/xml, application/atom+xml, application/json",
  "application/json, application/atom+xml, application/xml",
  "application/xml;q=0.5, application/json;q=0.5",
  "application/json;q=0.5, application/xml;q=0.5",
  "application/json;q=0.5, text/yaml;q=0.6",
  "application/x-yaml",
  "text/yaml",
  "application/yaml",
  "application/yaml, application/json",
  "text/plain",
  "text/html",
  "application/xhtml+xml",
  "text/javascript",
  "application/javascript",
  "text/css",
  "text/csv",
  "application/pdf",
  "image/png",
  "image/*",
  "foo/bar",
  "garbage",
  "text/html, garbage",
  "garbage, application/json",
  "application/json,",
  ",application/json",
  ";q=0.5, application/json",
  "application/json; version=2",
  "Application/JSON",
  "application/json, application/json;q=0.1",
  "application/json;q=0, text/html",
  "text/calendar, application/json",
  "application/atom+xml, application/json",
  "application/rss+xml, application/json",
  "application/x-www-form-urlencoded, application/json",
  "multipart/form-data, application/json",
  "application/json; q=\"0.5\", text/html",
  "text/html;level=1, application/json",
  "application/json;q=0.55, text/html;q=0.54",
  "application/json;q=.9, text/html;q=0.8",
  "application/json;q=1e-1, text/html;q=0.05",
  "application/json;q=, text/html",
  "text/html ; q=0.5 , application/json",
].freeze

# Variations that decide the format before or after the Accept header: `parameters[:format]`, the path extension, XHR.
VARIANTS = [
  { "name" => "plain" },
  { "name" => "head", "method" => "HEAD" },
  { "name" => "query format json", "query" => "format=json" },
  { "name" => "query format xml", "query" => "format=xml" },
  { "name" => "query format html", "query" => "format=html" },
  { "name" => "query format unknown", "query" => "format=nosuch" },
  { "name" => "query format empty", "query" => "format=" },
  { "name" => "query format uppercase", "query" => "format=JSON" },
  { "name" => "query format valueless", "query" => "format" },
  { "name" => "query format yaml", "query" => "format=yaml" },
  { "name" => "query format text", "query" => "format=text" },
  { "name" => "path extension json", "path" => "#{PATH}.json" },
  { "name" => "path extension xml", "path" => "#{PATH}.xml" },
  { "name" => "path extension unknown", "path" => "#{PATH}.nosuch" },
  { "name" => "path extension uppercase", "path" => "#{PATH}.JSON" },
  { "name" => "path extension yml", "path" => "#{PATH}.yml" },
  { "name" => "path extension txt", "path" => "#{PATH}.txt" },
  { "name" => "path extension and query format", "path" => "#{PATH}.xml", "query" => "format=json" },
  { "name" => "xhr", "headers" => { "HTTP_X_REQUESTED_WITH" => "XMLHttpRequest" } },
  { "name" => "xhr with json content type", "headers" => { "HTTP_X_REQUESTED_WITH" => "XMLHttpRequest", "CONTENT_TYPE" => "application/json" } },
  { "name" => "json content type", "headers" => { "CONTENT_TYPE" => "application/json" } },
  { "name" => "post", "method" => "POST" },
].freeze

# The Accept spread runs with the plain and HEAD requests; the other variants run with a few headers that discriminate.
SMALL_ACCEPTS = [nil, "application/json", "application/json, text/html", "text/html", "*/*", "application/xml", "text/plain"].freeze
TEST_MODE_VARIANTS = ["plain", "head", "query format json", "path extension json", "xhr with json content type"].freeze

env_config = Rails.application.env_config
app = Rack::MockRequest.new(Rails.application)
cases = []

record = lambda do |mode, variant, accept|
  path = variant["path"] || PATH
  path += "?#{variant['query']}" if variant["query"]
  env = { "HTTP_HOST" => DOMAIN, "REMOTE_ADDR" => "127.0.0.1" }.merge(variant["headers"] || {})
  env["HTTP_ACCEPT"] = accept unless accept.nil?
  response = app.request(variant["method"] || "GET", path, env)
  cases << {
    "mode" => mode,
    "variant" => variant["name"],
    "method" => variant["method"] || "GET",
    "path" => path,
    "headers" => variant["headers"] || {},
    "accept" => accept,
    "status" => response.status,
    "content_type" => response.headers["content-type"],
    "x_cascade" => response.headers["x-cascade"],
    "body" => if response.body.bytesize > 5000 then "<exception debug page>"
              elsif response.body == PUBLIC_404 then "<public/404.html>"
              else response.body
              end,
  }
end

env_config["action_dispatch.show_exceptions"] = :all
env_config["action_dispatch.show_detailed_exceptions"] = false
VARIANTS.each do |variant|
  (%w[plain head].include?(variant["name"]) ? ACCEPTS : SMALL_ACCEPTS).each { |accept| record.call("production", variant, accept) }
end

env_config["action_dispatch.show_exceptions"] = :rescuable
env_config["action_dispatch.show_detailed_exceptions"] = true
VARIANTS.select { TEST_MODE_VARIANTS.include?(_1["name"]) }.each do |variant|
  SMALL_ACCEPTS.each { |accept| record.call("test", variant, accept) }
end

File.write(OUT, JSON.pretty_generate({ "cases" => cases }) + "\n")
puts "wrote #{OUT.relative_path_from(Rails.root)} (#{cases.size} cases)"

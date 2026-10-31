# frozen_string_literal: true

# Produces mail.golden.json: renders the real mailers, views and layouts (app/mailers,
# app/views, app/helpers/mailer_helper.rb, config/initializers/mail_encodings.rb) with the real
# ActionMailer, mail, premailer-rails and nokogiri gems pinned in Gemfile.lock, and records the full
# encoded message and the Sidekiq payload `deliver_later` pushes. Models are plain structs: the
# mailers only read attributes.
#
#   G=<scratchpad>; GEM_HOME=$G/mail-gems GEM_PATH=$G/mail-gems:$G/gems:$G/ws05-gems \
#     REDIS_URL=redis://127.0.0.1:6379/9 ruby generate-mail-golden.rb
#
# mail-gems holds the gems none of the other golden scripts needed:
#   gem install --ignore-dependencies actionmailer:8.1.3.1 activejob:8.1.3.1 mail:2.9.0 \
#     mini_mime:1.1.5 net-smtp:0.5.1 net-protocol:0.2.2 premailer:1.29.0 premailer-rails:1.12.0 \
#     css_parser:1.22.0 htmlentities:4.3.4 addressable:2.9.0 public_suffix:5.1.1 globalid:1.3.0
#
# The stylesheet is __fixtures__/email.css, `sass --style=compressed` of
# app/javascript/entrypoints/email.scss: the production file is a build artifact, and both sides
# read whatever file the manifest names, so any real email CSS exercises the same code.
gem "json", "2.13.2"
gem "concurrent-ruby", "1.3.8"
gem "connection_pool", "3.0.2"
gem "globalid", "1.3.0"
gem "redis-client", "0.22.2"
gem "nokogiri", "1.19.4"
ENV["TZ"] = "UTC"
ENV["RAILS_ENV"] = "production"
require "json"
require "pathname"
require "active_support"
require "active_support/all"
require "action_mailer"
require "action_dispatch"
require "action_dispatch/routing"
require "action_controller"
require "active_job"
require "global_id"
require "nokogiri"
require "premailer"
require "premailer/rails"
require "sidekiq"
require "sidekiq_unique_jobs"
require File.join(Gem::Specification.find_by_name("sidekiq", "7.3.4").gem_dir, "lib/active_job/queue_adapters/sidekiq_adapter.rb")

ROOT = File.expand_path("../../../../..", __dir__)
FIXTURES = __dir__
REDIS_URL = ENV.fetch("REDIS_URL", "redis://127.0.0.1:6379/9")
abort "Refusing to run against db 0" unless REDIS_URL.match?(%r{/\d+\z}) && !REDIS_URL.end_with?("/0")

# --- config the initializers set (production values from config/domain.rb) ----------------------
PROTOCOL = "https"
DOMAIN = "gumroad.com"
ASSET_DOMAIN = "assets.gumroad.com"
DEFAULT_EMAIL_DOMAIN = "gumroad.com"
CSS_HREF = "https://assets.gumroad.com/vite/assets/email-golden.css"

module Rails
  def self.env = ActiveSupport::EnvironmentInquirer.new(ENV.fetch("RAILS_ENV"))
end

module GumroadAddress
  def self.full = "548 Market St, San Francisco, CA 94104-5401, USA"
end

require "mail"
Mail.eager_autoload!
Mail::Encodings::QuotedPrintable
require File.join(ROOT, "config/initializers/mail_encodings.rb")

GlobalID.app = "gumroad"
ActiveJob::Base.logger = Logger.new(nil)
ActionMailer::Base.logger = Logger.new(nil)
ActiveJob::Base.queue_adapter = :sidekiq
ActionMailer::Base.view_paths = [File.join(ROOT, "app/views")]
ActionMailer::Base.asset_host = "#{PROTOCOL}://#{ASSET_DOMAIN}"
ActionMailer::Base.delivery_method = :test
ActionMailer::Base.deliver_later_queue_name = :default
ActionMailer::Base.register_interceptor(Premailer::Rails::Hook)

Sidekiq.configure_client do |config|
  config.redis = { url: REDIS_URL }
  config.client_middleware { |chain| chain.add SidekiqUniqueJobs::Middleware::Client }
end
Sidekiq.default_job_options = { "backtrace" => true, "retry" => 25 }

# EmailStylesheetLoader#load for the built stylesheet: public_file, then unwrap_layers. The loader
# itself needs Rails.public_path and SsrfFilter, so its unwrap_layers is evaluated from source.
module EmailStylesheetLoader
  extend self
  source = File.read(File.join(ROOT, "lib/utilities/email_stylesheet_loader.rb"))
  body = source[/^    def unwrap_layers\(css\)\n.*?^    end\n/m] or abort "unwrap_layers not found"
  module_eval(body)
  public :unwrap_layers

  EXTRA = {}

  def load(url)
    return unwrap_layers(EXTRA.fetch(url)) if EXTRA.key?(url)
    raise "unexpected stylesheet #{url}" unless url == CSS_HREF
    unwrap_layers(File.read(File.join(FIXTURES, "email.css")))
  end
end
Premailer::Rails.config[:remove_ids] = false
Premailer::Rails.config[:preserve_style_attribute] = true
Premailer::Rails.config[:strategies] = [EmailStylesheetLoader]

module ApplicationHelper
  def vite_entrypoint_stylesheet_tag(_name, **options)
    stylesheet_link_tag(CSS_HREF, **options, extname: false)
  end
end
module ViteRails
  module TagHelpers; end
end
module RescueSmtpErrors
  extend ActiveSupport::Concern
end
require File.join(ROOT, "app/helpers/mailer_helper.rb")

# --- routes the views use ------------------------------------------------------------------------
ROUTES = ActionDispatch::Routing::RouteSet.new
ROUTES.draw do
  root to: "home#index"
  get "/users/confirmation", to: "confirmations#show", as: :user_confirmation
  get "/users/password/edit", to: "passwords#edit", as: :edit_user_password
end
ActionMailer::Base.include ROUTES.url_helpers
ActionMailer::Base.include ROUTES.mounted_helpers
ActionMailer::Base.default_url_options = { host: DOMAIN, protocol: PROTOCOL }

# --- Devise: the gem's mailer and helpers, with the mapping Devise builds for devise_for :users ---
DEVISE = Pathname(Gem::Specification.find_by_name("devise", "4.9.4").gem_dir)
module Devise
  Mapping = Struct.new(:name, :scoped_path) do
    def self.find_scope!(_record) = :user
  end
  def self.parent_mailer = "ActionMailer::Base"
  def self.scoped_views = false
  def self.mappings = { user: Mapping.new(:user, "users") }
  def self.mailer_sender = ->(_mapping) { ApplicationMailer::NOREPLY_EMAIL_WITH_NAME }
  module Controllers
    module UrlHelpers
      %i[confirmation password].each do |name|
        %i[url path].each do |kind|
          define_method(:"#{name}_#{kind}") { |_resource, *args| send(:"user_#{name}_#{kind}", *args) }
          define_method(:"edit_#{name}_#{kind}") { |_resource, *args| send(:"edit_user_#{name}_#{kind}", *args) }
        end
      end
    end
  end
end
require DEVISE.join("lib/devise/controllers/scoped_views.rb").to_s
require DEVISE.join("lib/devise/mailers/helpers.rb").to_s
I18n.load_path += [DEVISE.join("config/locales/en.yml").to_s, File.join(ROOT, "config/locales/devise.en.yml")]
I18n.available_locales = [:en]
# Rails sets this from config.time_zone, which defaults to "UTC"; ActiveJob serializes its name.
Time.zone_default = Time.find_zone!("UTC")

class ApplicationMailer < ActionMailer::Base
  NOREPLY_EMAIL = "noreply@#{DEFAULT_EMAIL_DOMAIN}"
  NOREPLY_EMAIL_WITH_NAME = email_address_with_name(NOREPLY_EMAIL, "Gumroad")
end
require DEVISE.join("app/mailers/devise/mailer.rb").to_s
Devise::Mailer.helper Devise::Controllers::UrlHelpers
Devise::Mailer.include Devise::Controllers::UrlHelpers
require File.join(ROOT, "app/mailers/user_signup_mailer.rb")

# config.action_mailer.delivery_job = "MailDeliveryJob"
module Net
  class SMTPServerBusy < StandardError; end unless defined?(Net::SMTPServerBusy)
end
require File.join(ROOT, "app/jobs/mail_delivery_job.rb")
ActionMailer::Base.delivery_job = MailDeliveryJob

# --- models ----------------------------------------------------------------------------------------
class User
  include GlobalID::Identification
  ATTRS = %i[id email unconfirmed_email confirmation_token external_id name].freeze
  attr_accessor(*ATTRS)
  def initialize(**attrs) = attrs.each { |k, v| public_send(:"#{k}=", v) }
  def suspended? = @suspended
  attr_writer :suspended
  def self.find(id) = USERS.fetch(id.to_i)
  def self.primary_key = "id"
end
USERS = {}

# --- recording -------------------------------------------------------------------------------------
def record_message(mail)
  rendered = mail.message.body.raw_source.dup
  mail.deliver_now
  message = ActionMailer::Base.deliveries.last
  {
    "rendered_html" => rendered,
    "text_part" => message.text_part.body.decoded,
    "html_part" => message.html_part.body.decoded,
    "encoded" => message.encoded,
    "smtp_envelope_from" => message.smtp_envelope_from,
    "smtp_envelope_to" => message.smtp_envelope_to,
  }
end

def record_enqueue
  Sidekiq.redis(&:flushdb)
  yield
  queues = Sidekiq.redis { |c| c.keys("queue:*") }
  pushed = queues.flat_map { |q| Sidekiq.redis { |c| c.lrange(q, 0, -1) } }
  scheduled = Sidekiq.redis { |c| c.zrange("schedule", 0, -1, "withscores") }
  { "queued" => pushed, "scheduled" => scheduled.map { |payload, score| { "payload" => payload, "score" => score.to_s } } }
end

FIXED_NOW = Time.utc(2026, 10, 31, 12, 0, 0)

cases = []
user = User.new(id: 1234, email: "seller@example.com", unconfirmed_email: nil, confirmation_token: "Tok3n-abc_DEF", external_id: "8723460912345", name: "Seller")
USERS[user.id] = user
changed = User.new(id: 5678, email: "old@example.com", unconfirmed_email: "new+tag@example.org", confirmation_token: "zZ9_yY8-xX7", external_id: "1111111111111", name: "Ünïcode: Name")
USERS[changed.id] = changed
synced = User.new(id: 91, email: "now@example.net", unconfirmed_email: nil, confirmation_token: "q", external_id: "42", name: nil)
USERS[synced.id] = synced
suspended = User.new(id: 92, email: "susp@example.com", external_id: "43", suspended: true)
USERS[suspended.id] = suspended

MAILS = [
  ["confirmation_instructions", -> { UserSignupMailer.confirmation_instructions(user, "raw-token", {}) }, [user, "raw-token", {}]],
  ["reconfirmation_instructions", -> { UserSignupMailer.confirmation_instructions(changed, "raw-token", { to: changed.unconfirmed_email }) }, [changed, "raw-token", { to: changed.unconfirmed_email }]],
  ["email_changed", -> { UserSignupMailer.email_changed(changed, { to: changed.email }) }, [changed, { to: changed.email }]],
  ["email_changed_synced", -> { UserSignupMailer.email_changed(synced, { to: "before@example.net" }) }, [synced, { to: "before@example.net" }]],
  ["email_changed_no_to", -> { UserSignupMailer.email_changed(synced, {}) }, [synced, {}]],
]

MAILS.each do |name, build, _args|
  cases << { "name" => name, "kind" => "message", **record_message(build.call) }
end

# User::AsyncDeviseNotification#render_and_send_devise_message
ENQUEUES = [
  ["deliver_later_confirmation", -> { UserSignupMailer.confirmation_instructions(user, "raw-token", {}).deliver_later(queue: "critical", wait: 3.seconds) }],
  ["deliver_later_reconfirmation", -> { UserSignupMailer.confirmation_instructions(changed, "raw-token", { to: "new+tag@example.org" }).deliver_later(queue: "critical", wait: 3.seconds) }],
  ["deliver_later_email_changed", -> { UserSignupMailer.email_changed(changed, { to: "old@example.com" }).deliver_later(queue: "critical", wait: 3.seconds) }],
  ["deliver_later_default_queue", -> { UserSignupMailer.email_changed(changed, {}).deliver_later }],
]
ENQUEUES.each do |name, enqueue|
  cases << { "name" => name, "kind" => "enqueue", **record_enqueue(&enqueue) }
end

# Premailer on markup and CSS the reference mailers do not reach: tables and the attributes premailer
# copies from CSS, lists, headings, shorthands, !important, inline styles, media and print rules.
PREMAILER_CSS = <<~CSS
  @import url("other.css") screen;
  @charset "utf-8";
  /* comment { color: red } */
  @layer base { :root { --x: 1px; } .layered { color: blue } }
  @layer theme;
  body { background-color: rgb(255, 255, 255); margin: 0 auto; font: italic bold 12px/30px Georgia, serif; }
  table.t { background-color: #fafafa; -premailer-width: 600px; -premailer-cellpadding: 4; border: 1px solid #ccc; }
  td { text-align: center; vertical-align: top; padding: 1px 2px 3px; background: url("x.png") no-repeat #fff; }
  td.right { text-align: right !important; padding: 0; }
  tr:nth-child(2n) td { background-color: rgb(1 2 3); }
  td:first-child { border-left: 2px dashed red; border-top: thin dotted rgba(0, 0, 0, 0.5); }
  h1 { font-size: 24px; text-align: left; } h3 { margin: 0 0 8px 0; }
  p { margin: 0; padding: 0 0 0 0; color: #333; }
  p.lead { margin: 4px 8px; font-weight: 700 !important; }
  .note { color: red; } p.note { color: green; } #main .note { color: blue; }
  ul li { list-style: square inside; } li + li { margin-top: 4px; }
  a:hover { color: purple; } a:link { color: navy; } a::after { content: "x"; }
  img { border: 0; float: left; -premailer-width: 20px; }
  div > :not(.skip) { line-height: 1.5; }
  @media (max-width: 600px) { .t { width: 100% !important; } p { font-size: 14px } }
  @media print { p { color: black; } }
  @media screen and (min-width: 1px), print and (orientation:landscape) { .wide { display: block } }
  .bg { background: linear-gradient(to right, #fff 0%, #000 100%); background-size: cover; }
  .calc { margin: calc(1px + 2px) var(--a, 4px); }
  .unclosed { color: red
CSS
PREMAILER_HTML = <<~HTML
  <!DOCTYPE html>
  <html>
    <head>
      <title>Premailer &amp; friends</title>
      <meta content="text/html; charset=UTF-8" http-equiv="Content-Type">
      <link rel="stylesheet" href="https://assets.gumroad.com/vite/assets/extra.css">
      <style>.inline-style { font-style: italic; } @media (min-width: 10px) { .inline-style { color: red } }</style>
    </head>
    <body>
      <div id="main" class="layered" contenteditable="true">
        <h1>Héading one</h1>
        <h3>Third <br>level</h3>
        <p class="lead note" style="color: orange; margin-top: 2px">Lead &lt;text&gt; &amp; “quotes” — ünïcödé&nbsp;here</p>
        <p class="note">Note <span>one</span>   <span>two</span></p>
        <table class="t" cellspacing="0">
          <tr><td>a</td><td class="right">b</td></tr>
          <tr><td>c</td><td>d</td></tr>
        </table>
        <ul><li>first</li><li>second <a href="mailto:x@example.com">x@example.com</a></li><li><a href="https://example.com/a b?c=1&amp;d=2">Example link that is long enough to wrap the plain text line</a></li></ul>
        <img src="https://example.com/i.png" alt="Logo">
        <div class="bg calc wide inline-style"><p class="skip">s</p><span>t</span></div>
        <script>alert(1)</script>
      </div>
    </body>
  </html>
HTML
EmailStylesheetLoader::EXTRA["https://assets.gumroad.com/vite/assets/extra.css"] = PREMAILER_CSS
pm = Premailer::Rails::CustomizedPremailer.new(PREMAILER_HTML)
text = pm.to_plain_text
cases << { "name" => "premailer_kitchen_sink", "kind" => "premailer", "rendered_html" => PREMAILER_HTML, "css" => PREMAILER_CSS, "text_part" => text, "html_part" => pm.to_inline_css }

File.write(File.join(FIXTURES, "mail.golden.json"), JSON.pretty_generate({ "hostname" => Socket.gethostname, "cases" => cases }) + "\n")
puts "wrote #{cases.size} cases"

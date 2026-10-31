# frozen_string_literal: true

# Golden vectors for nextjs/src/server/models/user.ts. Runs the validations and normalizations of
# app/models/user.rb itself: the `stripped_fields`, `validates`, `validate` and `before_validation`
# declarations and the helper methods they call are read out of user.rb with Prism and evaluated on
# a SQLite-backed model, next to the real validators (app/validators), StrippedFields, JsonData,
# User::Validations and User::EmailNormalization, and the real DENYLIST, KINDLE_EMAIL_REGEX,
# currencies.json and ActiveSupport::TimeZone::MAPPING. Only the collaborators the declarations reach
# outside the model are stubbed: PlatformBlock (a table), GmailAbuseFilter (a set) and the avatar.
# SQLite compares strings case-sensitively where MySQL's collation does not, so no case relies on
# a case-insensitive match. Devise and its pwned_password validation are not loaded here.
#
#   ruby nextjs/scripts/golden/user.rb   (activerecord 8.1.3.1, sqlite3, prism, mail 2.9.0)
gem "json", "2.13.2"
gem "activerecord", "8.1.3.1"
require "json"
require "set"
require "pathname"
require "prism"
require "active_record"
require "active_support/all"
require "mail"

ROOT = File.expand_path("../../..", __dir__)
OUT = File.join(ROOT, "nextjs/src/server/models/__fixtures__/user.golden.json")
# The constant lists user.ts reads at runtime, written from the same Ruby so they cannot drift.
DATA_OUT = File.join(ROOT, "nextjs/src/server/models/user-data.generated.json")

module Rails
  def self.root = Pathname.new(ROOT)
  def self.env = ActiveSupport::StringInquirer.new("test")
end

Time.zone = "UTC"
ActiveRecord.default_timezone = :utc
ActiveRecord::Base.establish_connection(adapter: "sqlite3", database: ":memory:")
ActiveRecord::Schema.verbose = false
ActiveRecord::Schema.define do
  create_table :users do |t|
    t.string :email, default: ""
    t.string :username
    t.string :name
    t.string :external_id
    t.string :facebook_meta_tag
    t.integer :purchasing_power_parity_limit
    t.string :provider
    t.string :kindle_email
    t.string :support_email
    t.string :google_analytics_id
    t.string :facebook_pixel_id
    t.string :timezone, default: "Pacific Time (US & Canada)", null: false
    t.string :recommendation_type, null: false
    t.string :currency_type, default: "usd"
    t.text :json_data
    t.string :payment_address
    t.string :account_created_ip
    t.string :unconfirmed_email
    t.string :notification_endpoint
    t.datetime :confirmed_at
    t.datetime :deleted_at
    t.boolean :is_team_member, default: false
  end
  create_table :platform_blocks do |t|
    t.string :object_type
    t.string :object_value
    t.datetime :blocked_at
    t.datetime :expires_at
  end
end

USER_SOURCE = File.read(File.join(ROOT, "app/models/user.rb"))
user_class = Prism.parse(USER_SOURCE).value.statements.body.find { _1.is_a?(Prism::ClassNode) }
body = user_class.body.body

# The model-level declarations, in user.rb's order.
DECLARATIONS = %i[stripped_fields validates validate validates_presence_of validates_confirmation_of validates_length_of before_validation]
DECLARATION_SOURCES = body.select { _1.is_a?(Prism::CallNode) && _1.receiver.nil? && DECLARATIONS.include?(_1.name) }.map(&:slice)
SCOPE_SOURCES = body.select { _1.is_a?(Prism::CallNode) && _1.name == :scope && _1.arguments.arguments.first.unescaped == "by_email" }.map(&:slice)
METHODS = %i[username read_attribute_for_validation email_domain form_email append_http password_required? email_required? to_email_domain]

def find_def(node, name)
  return node if node.is_a?(Prism::DefNode) && node.name == name
  node.compact_child_nodes.each do |child|
    found = find_def(child, name)
    return found if found
  end
  nil
end
program = Prism.parse(USER_SOURCE).value
METHOD_SOURCES = METHODS.map { |name| find_def(program, name)&.slice or raise("def #{name} not found in user.rb") }

constants_source = File.read(File.join(ROOT, "config/initializers/004_constants.rb"))
DENYLIST = eval(constants_source[/^DENYLIST = %w\[.*?\]/m].delete_prefix("DENYLIST = ")).freeze
aws_source = File.read(File.join(ROOT, "config/initializers/aws.rb"))
KINDLE_EMAIL_REGEX = eval(aws_source[%r{^KINDLE_EMAIL_REGEX = /.*?/xi}m].delete_prefix("KINDLE_EMAIL_REGEX = "))
CURRENCY_CHOICES = ActiveSupport::HashWithIndifferentAccess.new(JSON.load_file(File.join(ROOT, "config/currencies.json"))["currencies"])

%w[email_format disposable_email not_reserved_email_domain blocked_username].each do |name|
  load File.join(ROOT, "app/validators/#{name}_validator.rb")
end
load File.join(ROOT, "app/models/concerns/stripped_fields.rb")
load File.join(ROOT, "app/models/concerns/json_data.rb")

class PlatformBlock < ActiveRecord::Base
  TYPES = { ip_address: "ip_address", email: "email", email_domain: "email_domain" }.freeze
  scope :active, -> { where.not(blocked_at: nil).where("expires_at IS NULL OR expires_at > ?", Time.current) }
end

GMAIL_ABUSE = Set.new
module GmailAbuseFilter
  def self.exists?(email)
    normalized = User.normalize_gmail_address(email)
    !normalized.nil? && GMAIL_ABUSE.include?(normalized)
  end
end

class User < ActiveRecord::Base
  module PayoutSchedule
    src = File.read(File.join(ROOT, "app/modules/user/payout_schedule.rb"))
    %w[WEEKLY MONTHLY QUARTERLY DAILY].each { |c| const_set(c, src[/^  #{c} = "(\w+)"/, 1]) }
  end
  DELETED_ACCOUNT_HOLDS_EMAIL_ERROR = Prism.parse(USER_SOURCE).value.then { |p|
    stack = [p]
    found = nil
    until stack.empty? || found
      node = stack.pop
      found = node.value.unescaped if node.is_a?(Prism::ConstantWriteNode) && node.name == :DELETED_ACCOUNT_HOLDS_EMAIL_ERROR
      stack.concat(node.compact_child_nodes)
    end
    found
  }
  INVALID_NAME_FOR_EMAIL_DELIVERY_REGEX = /:/
  MAX_LENGTH_NAME = 100
  MAX_LENGTH_FACEBOOK_META_TAG = 100
end
load File.join(ROOT, "app/models/concerns/user/recommendation_type.rb")
load File.join(ROOT, "app/modules/user/validations.rb")
load File.join(ROOT, "app/models/concerns/user/email_normalization.rb")

class User
  include StrippedFields
  include JsonData
  include User::Validations
  include User::EmailNormalization

  attribute :recommendation_type, default: User::RecommendationType::OWN_PRODUCTS
  attr_accessor :password, :password_confirmation
  attr_json_data_accessor :payout_frequency, default: User::PayoutSchedule::WEEKLY
  attr_json_data_accessor :custom_fee_per_thousand
  attr_json_data_accessor :tiktok_pixel_id

  def is_team_member? = is_team_member
  def confirmed? = !!confirmed_at
  def deleted? = deleted_at.present?
  def avatar = Struct.new(:attached?).new(false)

  def blocked_by_email_domain? = blocked?("email_domain", email_domain)
  def blocked_by_account_created_ip? = blocked?("ip_address", account_created_ip)

  def blocked?(type, value)
    value.present? && PlatformBlock.active.where(object_type: type, object_value: value).exists?
  end

  SCOPE_SOURCES.each { |source| class_eval(source) }
  METHOD_SOURCES.each { |source| class_eval(source) }
  DECLARATION_SOURCES.each { |source| class_eval(source) }
  private :password_required?, :email_required?, :to_email_domain
end

PlatformBlock.create!(object_type: "email_domain", object_value: "blocked.example", blocked_at: Time.current)
PlatformBlock.create!(object_type: "email_domain", object_value: "expired.example", blocked_at: Time.current, expires_at: 1.day.ago)
PlatformBlock.create!(object_type: "ip_address", object_value: "10.0.0.9", blocked_at: Time.current, expires_at: 1.day.from_now)
GMAIL_ABUSE << "suspended@gmail.com"

EXISTING = [
  { id: 1, email: "taken@example.com", username: "takenname", recommendation_type: "own_products", json_data: nil },
  { id: 2, email: "gone@example.com", username: "goneuser", recommendation_type: "own_products", deleted_at: Time.utc(2024, 1, 1) },
  { id: 3, email: "member@example.com", username: "member", recommendation_type: "own_products", is_team_member: true, confirmed_at: Time.utc(2024, 1, 1), json_data: { "payout_frequency" => "weekly" } },
]
EXISTING.each { |attrs| User.insert!(attrs.merge(timezone: "Pacific Time (US & Canada)", currency_type: "usd")) }

NEW_BASE = { email: "new@example.com", password: "secret-password", password_confirmation: "secret-password" }.freeze

CASES = [
  ["valid new account", :new, NEW_BASE],
  ["blank email without provider", :new, NEW_BASE.merge(email: "   ")],
  ["blank email with provider", :new, NEW_BASE.merge(email: "", provider: "twitter")],
  ["email already taken", :new, NEW_BASE.merge(email: "taken@example.com")],
  ["email held by a deleted account", :new, NEW_BASE.merge(email: "gone@example.com")],
  ["malformed email", :new, NEW_BASE.merge(email: "not-an-email")],
  ["email with invisible characters and spaces", :new, NEW_BASE.merge(email: "‏  spaced @example.com ")],
  ["disposable email", :new, NEW_BASE.merge(email: "someone@mailinator.com")],
  ["blocked email domain", :new, NEW_BASE.merge(email: "someone@blocked.example")],
  ["expired email domain block", :new, NEW_BASE.merge(email: "someone@expired.example")],
  ["blocked signup ip", :new, NEW_BASE.merge(account_created_ip: "10.0.0.9")],
  ["gmail variant of a suspended account", :new, NEW_BASE.merge(email: "Sus.Pended+promo@googlemail.com")],
  ["missing password", :new, NEW_BASE.merge(password: nil, password_confirmation: nil)],
  ["password confirmation mismatch", :new, NEW_BASE.merge(password_confirmation: "different")],
  ["short password", :new, NEW_BASE.merge(password: "abc", password_confirmation: "abc")],
  ["password at the length limits", :new, NEW_BASE.merge(password: "a" * 127, password_confirmation: "a" * 127)],
  ["over-long password", :new, NEW_BASE.merge(password: "a" * 128, password_confirmation: "a" * 128)],
  ["unknown timezone", :new, NEW_BASE.merge(timezone: "Mars/Olympus")],
  ["known timezone", :new, NEW_BASE.merge(timezone: "Eastern Time (US & Canada)")],
  ["unsupported currency", :new, NEW_BASE.merge(currency_type: "xyz")],
  ["unknown recommendation type", :new, NEW_BASE.merge(recommendation_type: "everything")],
  ["custom fee out of range", :new, NEW_BASE.merge(custom_fee_per_thousand: 1001)],
  ["custom fee not an integer", :new, NEW_BASE.merge(custom_fee_per_thousand: 12.5)],
  ["custom fee as a numeric string", :new, NEW_BASE.merge(custom_fee_per_thousand: "50")],
  ["custom fee as text", :new, NEW_BASE.merge(custom_fee_per_thousand: "abc")],
  ["bad payout frequency", :new, NEW_BASE.merge(payout_frequency: "hourly")],
  ["ppp limit out of range", :new, NEW_BASE.merge(purchasing_power_parity_limit: 0)],
  ["name with a colon and padding", :new, NEW_BASE.merge(name: "  Jane:   Doe  ")],
  ["name too long", :new, NEW_BASE.merge(name: "é" * 101)],
  ["invalid google analytics id", :new, NEW_BASE.merge(google_analytics_id: "UA-1234")],
  ["google analytics id inside text", :new, NEW_BASE.merge(google_analytics_id: "  prefix G-ABC123  ")],
  ["tiktok pixel with padding", :new, NEW_BASE.merge(tiktok_pixel_id: "  C4ABC123  ")],
  ["lowercase tiktok pixel", :new, NEW_BASE.merge(tiktok_pixel_id: "c4abc")],
  ["facebook pixel with padding", :new, NEW_BASE.merge(facebook_pixel_id: " \t123456789\n")],
  ["facebook pixel with a leading zero", :new, NEW_BASE.merge(facebook_pixel_id: "0123")],
  ["valid facebook meta tag", :new, NEW_BASE.merge(facebook_meta_tag: "<meta name=\"facebook-domain-verification\" content=\"abc123\" />")],
  ["invalid facebook meta tag", :new, NEW_BASE.merge(facebook_meta_tag: "<meta name='facebook-domain-verification' content=\"abc\" />")],
  ["malformed facebook meta tag", :new, NEW_BASE.merge(facebook_meta_tag: "<meta name=fb content=x>")],
  ["valid kindle email", :new, NEW_BASE.merge(kindle_email: "Reader@KINDLE.com")],
  ["invalid kindle email", :new, NEW_BASE.merge(kindle_email: "reader@example.com")],
  ["invalid support email", :new, NEW_BASE.merge(support_email: "nope")],
  ["reserved support email", :new, NEW_BASE.merge(support_email: "help@Gumroad.com")],
  ["invalid payment address", :new, NEW_BASE.merge(payment_address: "pay me")],
  ["username taken", :new, NEW_BASE.merge(username: "takenname")],
  ["username too short", :new, NEW_BASE.merge(username: "ab")],
  ["username too long", :new, NEW_BASE.merge(username: "a" * 21)],
  ["username reserved", :new, NEW_BASE.merge(username: "admin")],
  ["username digits only", :new, NEW_BASE.merge(username: "12345")],
  ["username uppercase", :new, NEW_BASE.merge(username: "Seller")],
  ["username gambling", :new, NEW_BASE.merge(username: "slotgacor77")],
  ["username brand on another domain", :new, NEW_BASE.merge(username: "nikeofficial")],
  ["username blank becomes nil", :new, NEW_BASE.merge(username: "   ")],
  ["existing: no changes", 1, {}],
  ["existing: username unchanged still taken by nobody else", 3, { name: "Member" }],
  ["existing: rename to taken username", 3, { username: "takenname" }],
  ["existing: reserved support email by a team member", 3, { support_email: "help@gumroad.com" }],
  ["existing: email changed to a taken one", 3, { email: "taken@example.com" }],
  ["existing: colon in unchanged name is allowed", 1, { name: "a:b" }, :persist_first],
  ["existing: blank email is nilified", 1, { email: "" }],
  ["existing: notification endpoint without scheme", 1, { notification_endpoint: "example.com/ping" }],
]

def snapshot(user)
  {
    "errors" => user.errors.map { |e| { "attribute" => e.attribute.to_s, "type" => e.type.is_a?(Symbol) ? e.type.to_s : nil, "message" => e.message } },
    "full_messages" => user.errors.full_messages,
    "attributes" => user.attributes.slice(*%w[email username name facebook_meta_tag google_analytics_id support_email facebook_pixel_id notification_endpoint]),
    # What a save would write for json_data, and which attributes a save would write.
    "json_data" => User.type_for_attribute("json_data").serialize(user.read_attribute("json_data")),
    "changed" => user.changed.sort,
  }
end

# Each case runs in a rolled-back transaction so every case sees the seeded rows unchanged.
cases = CASES.map do |name, kind, attrs, mode|
  result = nil
  ActiveRecord::Base.transaction do
    user = kind == :new ? User.new : User.find(kind)
    if mode == :persist_first
      user.update_columns(attrs.transform_keys(&:to_s))
      user = User.find(kind)
    end
    assign = mode == :persist_first ? { notification_endpoint: "x" } : attrs
    assign.each { |key, value| user.public_send("#{key}=", value) }
    user.valid?
    user.send(:append_http)
    result = {
      "name" => name, "existing_id" => kind == :new ? nil : kind, "persist_first" => mode == :persist_first ? attrs.transform_keys(&:to_s) : nil,
      "assign" => assign.transform_keys(&:to_s), "result" => snapshot(user)
    }
    raise ActiveRecord::Rollback
  end
  result
end

CUSTOM_FEE_VALUES = [5, -1, 0, 1000, 1001, 5.0, 12.5, "50", " 50", "50 ", "+7", "-0", "1_000", "1e3", ".5", "5.", "abc", "0x1A", "", " ", true, false, [1], { "a" => 1 }, {}, nil]
custom_fee = CUSTOM_FEE_VALUES.map do |value|
  user = User.new(NEW_BASE)
  user.custom_fee_per_thousand = value
  user.valid?
  { "value" => value, "messages" => user.errors.messages_for(:custom_fee_per_thousand) }
end

STRINGS = ["  a  b  ", "​x‌‍­y﻿", " lead　trail ", "", "   ", "\t\nline\r\n", "a\u0085b", " x ", "\0 a \0"]
stripped = STRINGS.map do |value|
  object = Struct.new(:value) { def read_attribute(_) = value }.new(value)
  StrippedFields::StrippedField.before_validation(object, :value, remove_duplicate_spaces: true, transform: nil, nilify_blanks: true)
  { "input" => value, "stripped" => object.value, "ruby_strip" => value.strip }
end

EMAILS = ["a@b.co", "first.last@example.com", ".lead@example.com", "a..b@example.com", "\"quoted local\"@example.com", "user@[10.0.0.1]", "user@localhost", "user@exa_mple.com",
          "x@y.c", "ab@c.de", "a b@example.com", "us(er)@example.com", "user@example.com\n", "Ünïcode@example.com", "user@sub.example.co.uk", "#{'a' * 250}@b.com", "a@b@c.com",
          "Name <user@gumroad.com>", "user@GUMROAD.org", "user@gumroad.dev.", "@gumroad.com", "user@", "plain", "", "reader@kindle.com", "Reader@Kindle.COM", "re.ader@kindle.com"]
emails = EMAILS.map do |email|
  domain = begin
    Mail::Address.new(email).domain
  rescue Mail::Field::ParseError => e
    "ParseError"
  end
  {
    "email" => email,
    "email_format" => EmailFormatValidator.valid?(email),
    "kindle" => email.match?(KINDLE_EMAIL_REGEX),
    "reserved_domain" => NotReservedEmailDomainValidator.domain_reserved?(email),
    "mail_domain" => domain,
    "disposable" => DisposableEmailValidator.disposable?(email),
    "gmail_normalized" => User.normalize_gmail_address(email),
  }
end

USERNAMES = [["apple", nil], ["apple", "ceo@apple.com"], ["apple", "ceo@corp.apple.com"], ["theapplestore", "x@example.com"], ["appleofficial", nil], ["apple123", nil], ["apple12345", nil],
             ["pineapple", nil], ["virginmedia", "x@virginmedia.com"], ["bt1", nil], ["bt", "a@bt.com"], ["go88", nil], ["go88abc", nil], ["go88abcdefg", nil], ["casino7", nil], ["casinoking", nil],
             ["poker99", nil], ["pokercoach", nil], ["88bet", nil], ["nohu", nil], ["nohu12", nil], ["gumroadsupport", "a@gumroad.com"], ["", nil], ["UpperApple", nil]]
usernames = USERNAMES.map { |username, email| { "username" => username, "email" => email, "blocked" => BlockedUsernameValidator.blocked?(username, email:) } }

File.write(OUT, JSON.pretty_generate(
  "existing" => User.order(:id).map { |u| u.attributes_before_type_cast.slice(*%w[id email username deleted_at is_team_member confirmed_at json_data]) },
  "platform_blocks" => PlatformBlock.all.map { |b| b.attributes.slice("object_type", "object_value").merge("active" => PlatformBlock.active.exists?(b.id)) },
  "gmail_abuse" => GMAIL_ABUSE.to_a,
  "cases" => cases,
  "stripped_fields" => stripped,
  "custom_fee_per_thousand" => custom_fee,
  "emails" => emails,
  "usernames" => usernames,
) + "\n")
File.write(DATA_OUT, JSON.pretty_generate(
  "denylist" => DENYLIST,
  "time_zones" => ActiveSupport::TimeZone::MAPPING.keys,
  "currencies" => CURRENCY_CHOICES.keys,
  "recommendation_types" => User::RecommendationType::TYPES,
  "disposable_email_domains" => DisposableEmailValidator.disposable_domains.to_a,
) + "\n")
puts "Wrote #{OUT} (#{cases.size} cases) and #{DATA_OUT}"

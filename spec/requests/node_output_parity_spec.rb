# frozen_string_literal: true

require "spec_helper"

# Output of the Next.js port that Rails has to decode: the bcrypt digest of a changed password, the session cookie after Devise's
# bypass_sign_in, and the session and remember cookies of a passkey login. The replays write the files (WRITE_NODE_PASSWORD_CHANGE in
# settings-password-guards.replay.test.ts, WRITE_NODE_PASSKEY_SESSION in login-passkeys.replay.test.ts) and this spec reads them
# (NODE_PASSWORD_CHANGE, NODE_PASSKEY_SESSION), signing the cookies with the SECRET_KEY_BASE both sides boot with
# (parity-replay-secret-key-base). Not recorded as fixtures: it only runs when the files exist.
describe "Output of the Node port, read by Rails", type: :request do
  include Parity::SignedInDashboard

  NODE_SECRET_KEY_BASE = "parity-replay-secret-key-base"
  KEY_DERIVED_IVARS = %i[@caching_key_generator @app_env_config @message_verifiers].freeze

  # Test and development generate a random secret_key_base per checkout, so the app is booted onto the one the replays sign with and
  # put back afterwards (the key generator and the env that carries it are memoized).
  around do |example|
    app = Rails.application
    saved_secret = app.config.secret_key_base
    saved_ivars = KEY_DERIVED_IVARS.to_h { [_1, app.instance_variable_get(_1)] }
    app.config.secret_key_base = NODE_SECRET_KEY_BASE
    KEY_DERIVED_IVARS.each { app.remove_instance_variable(_1) if app.instance_variable_defined?(_1) }
    example.run
  ensure
    app.config.secret_key_base = saved_secret
    saved_ivars.each { |name, value| app.instance_variable_set(name, value) }
  end

  def node_output(variable)
    path = ENV[variable]
    skip "#{variable} is not set; run the replay with WRITE_#{variable} first" if path.blank? || !File.exist?(path)
    JSON.parse(File.read(path))
  end

  def create_user_like(node_user)
    user = create(:user, id: node_user["id"], email: node_user["email"], username: nil, created_at: Time.utc(2025, 1, 1))
    user.update_columns(encrypted_password: node_user["encrypted_password"], remember_created_at: node_user["remember_created_at"])
    user
  end

  # The replays read cookies back from the response unescaped; a browser sends the escaped value Node put in Set-Cookie.
  def set_node_cookie(output, key)
    cookies.merge("#{output.dig(key, "name")}=#{Rack::Utils.escape(output.dig(key, "value"))}; path=/", URI("#{PROTOCOL}://#{DOMAIN}/"))
  end

  def expect_signed_in(path)
    out = JSON.parse(File.read(ENV["NODE_PASSKEY_SESSION"])); c = out["session_cookie"]; e = Rack::MockRequest.env_for("http://app.test.gumroad.com/", "HTTP_COOKIE" => "#{c["name"]}=#{Rack::Utils.escape(c["value"])}").merge(Rails.application.env_config); puts "DBG decode=#{ActionDispatch::Request.new(e).cookie_jar.encrypted[c["name"]].inspect[0, 120]} sess=#{Rails.application.config.session_store.inspect} opts=#{Rails.application.config.action_dispatch.cookies_serializer.inspect}"
    get path, headers: { "Accept" => "text/html" }
    expect(response).to have_http_status(:ok)
  end

  describe "the settings password change" do
    it "hashes the new password the way Devise checks it and keeps the browser signed in", parity: false do
      output = node_output("NODE_PASSWORD_CHANGE")
      user = create_user_like(output["user"])
      set_node_cookie(output, "session_cookie")

      expect(user.reload.valid_password?(output["new_password"])).to be(true)
      expect_signed_in("/settings/password")
    end
  end

  describe "the passkey login" do
    it "reads the session cookie Node wrote", parity: false do
      output = node_output("NODE_PASSKEY_SESSION")
      create_user_like(output["user"])
      set_node_cookie(output, "session_cookie")

      expect_signed_in("/dashboard")
    end

    it "reads the remember cookie Node wrote", parity: false do
      output = node_output("NODE_PASSKEY_SESSION")
      create_user_like(output["user"])
      set_node_cookie(output, "remember_cookie")

      expect_signed_in("/dashboard")
    end
  end
end

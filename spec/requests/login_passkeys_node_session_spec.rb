# frozen_string_literal: true

require "spec_helper"

# The session and remember cookies the Next.js port set when it signed a user in with a passkey (nextjs/src/server/controllers/
# login-passkeys.ts, replayed by nextjs/parity/__tests__/login-passkeys.replay.test.ts, which writes the file below) must sign the
# user in on Rails exactly as the ones Devise sets: Warden reads the session cookie and Rememberable reads the remember cookie, each
# alone. The user row is rebuilt as Node left it, and the clock is the one the cookies were issued under.
describe "Passkey login cookies issued by Node", type: :request do
  let(:golden) { JSON.parse(Rails.root.join("spec/support/fixtures/login_passkeys_node_session.json").read) }
  let(:issued_at) { Time.iso8601(golden.fetch("issued_at")) }
  let(:user) do
    attributes = golden.fetch("user")
    create(:user, id: attributes["id"], email: attributes["email"]).tap do |record|
      record.update_columns(encrypted_password: attributes["encrypted_password"], remember_created_at: Time.iso8601(attributes["remember_created_at"]))
    end
  end

  before do
    host! DOMAIN
    user
    travel_to(issued_at + 5.seconds)
  end

  after { travel_back }

  def send_cookie(key)
    cookie = golden.fetch(key)
    cookies[cookie["name"]] = cookie["value"]
  end

  it "sends a visitor with no cookie to the login page" do
    get "/login"

    expect(response).to have_http_status(:ok)
  end

  it "signs the user in with the session cookie alone" do
    send_cookie("session_cookie")

    get "/login"

    expect(response).to have_http_status(:found)
    expect(response.location).to end_with("/dashboard")
  end

  it "signs the user in with the remember cookie alone" do
    send_cookie("remember_cookie")

    get "/login"

    expect(response).to have_http_status(:found)
    expect(response.location).to end_with("/dashboard")
  end

  it "stops authenticating the remember cookie once the password changes, as it carries the salt" do
    user.update_columns(encrypted_password: BCrypt::Password.create("another-long-password-1", cost: 4).to_s)
    send_cookie("remember_cookie")

    get "/login"

    expect(response).to have_http_status(:ok)
  end

  it "stops authenticating the session cookie once the user it names is gone" do
    send_cookie("session_cookie")
    user.delete

    get "/login"

    expect(response).to have_http_status(:ok)
  end
end

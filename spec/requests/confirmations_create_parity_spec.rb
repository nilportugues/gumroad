# frozen_string_literal: true

require "spec_helper"

# POST /users/confirmation (ConfirmationsController#create, Devise's resend form) recorded for the Next.js port (PARITY_RECORD=1) and
# replayed by nextjs/parity/__tests__/ws10-rest.replay.test.ts, which sends the last request of each example. An example named "hands ..."
# is one Node leaves to Rails: the replay asserts it reached Rails and wrote nothing. The three that end in the form with an error are
# compared whole (an unproven shape, such as a blank string or another case of a confirmed address, still hands back).
describe "ConfirmationsController#create", type: :request do
  include Parity::AudienceSignedIn

  let!(:unconfirmed) { create(:user, email: "pending@example.com", confirmed_at: nil) }

  before do
    # Signup stamped the send time just now, which is inside the resend floor.
    unconfirmed.update_columns(confirmation_sent_at: 2.minutes.ago)
    host! DOMAIN
    allow(ViteRuby.instance.manifest).to receive(:resolve_entries).and_return({ stylesheets: ["/vite-test.css"] })
    allow_any_instance_of(ActionView::Base).to receive(:vite_client_tag).and_return("")
    allow_any_instance_of(ActionView::Base).to receive(:vite_react_refresh_tag).and_return("")
    allow_any_instance_of(ActionView::Base).to receive(:vite_typescript_tag).and_return("")
  end

  it "queues the confirmation mail for an unconfirmed address and sends the visitor to the login page", parity: true do
    post "/users/confirmation", params: { authenticity_token: csrf_token, user: { email: "pending@example.com" } }

    expect(response).to redirect_to("http://#{DOMAIN}/users/sign_in")
    expect(ResendConfirmationEmailJob.jobs.size).to eq(1)
  end

  it "matches the address through the database collation, so case does not matter", parity: true do
    post "/users/confirmation", params: { authenticity_token: csrf_token, user: { email: "Pending@Example.com" } }

    expect(response).to redirect_to("http://#{DOMAIN}/users/sign_in")
    expect(ResendConfirmationEmailJob.jobs.size).to eq(1)
  end

  it "finds the account by the address it is changing to before the one it has", parity: true do
    changing = create(:user, email: "current@example.com")
    changing.update_columns(unconfirmed_email: "next@example.com", confirmation_sent_at: 2.minutes.ago)

    post "/users/confirmation", params: { authenticity_token: csrf_token, user: { email: "next@example.com" } }

    expect(response).to redirect_to("http://#{DOMAIN}/users/sign_in")
    expect(ResendConfirmationEmailJob.jobs.size).to eq(1)
  end

  it "redirects without queueing a second mail inside the one-minute floor", parity: true do
    unconfirmed.update_columns(confirmation_sent_at: 10.seconds.ago)

    post "/users/confirmation", params: { authenticity_token: csrf_token, user: { email: "pending@example.com" } }

    expect(response).to redirect_to("http://#{DOMAIN}/users/sign_in")
    expect(ResendConfirmationEmailJob.jobs.size).to eq(0)
  end

  it "renders the resend form with an error for an already confirmed address", parity: true do
    create(:user, email: "done@example.com")

    post "/users/confirmation", params: { authenticity_token: csrf_token, user: { email: "done@example.com" } }

    expect(response).to have_http_status(:ok)
    expect(response.body).to include("Email was already confirmed, please try signing in")
    expect(ResendConfirmationEmailJob.jobs.size).to eq(0)
  end

  it "renders the resend form with an error for an unknown address", parity: true do
    post "/users/confirmation", params: { authenticity_token: csrf_token, user: { email: "nobody@example.com" } }

    expect(response).to have_http_status(:ok)
    expect(response.body).to include("Email not found")
    expect(ResendConfirmationEmailJob.jobs.size).to eq(0)
  end

  it "renders the resend form with a blank email error when the request has no user parameters", parity: true do
    post "/users/confirmation", params: { authenticity_token: csrf_token }

    expect(response).to have_http_status(:ok)
    expect(response.body).to include("Email can&#39;t be blank")
    expect(ResendConfirmationEmailJob.jobs.size).to eq(0)
  end
end

# frozen_string_literal: true

# Produces nextjs/src/server/models/__fixtures__/seller-profile-styles.golden.json: SellerProfile#custom_styles
# (libsass over styles.scss.erb) and its colour helpers for a matrix of stored values, run by the real model.
# Run from the repository root under the test environment (no database rows are read or written):
#
#   RAILS_ENV=test bundle exec rails runner nextjs/scripts/golden/seller-profile-styles.rb
require "json"

OUT = Rails.root.join("nextjs/src/server/models/__fixtures__/seller-profile-styles.golden.json")

COLORS = %w[#ffffff #000000 #ff90e8 #ff0000 #00ff00 #0000ff #808080 #ffb4ab #9b1c12 #dc341e #123456 #fafafa #1a1a1a #f0a #FFF #AbCdEf #fffffe #7f7f7f].freeze
FONTS = SellerProfile::FONT_CHOICES
RADII = SellerProfile::BORDER_RADIUS_CHOICES.keys
HOVERS = SellerProfile::BUTTON_HOVER_OFFSETS.keys

def run(attributes)
  profile = SellerProfile.new(**attributes)
  profile.define_singleton_method(:custom_style_cache_name) { "ws64-golden/#{SecureRandom.hex(8)}" }
  [attributes, profile.custom_styles]
end

cases = []
COLORS.product(COLORS.first(8)).each do |highlight, background|
  cases << run(highlight_color: highlight, background_color: background)
end
FONTS.each { |font| cases << run(font:) }
RADII.each { |radius| cases << run(border_radius: radius) }
HOVERS.each { |hover| cases << run(button_hover: hover) }
cases << run(font: "Domine", highlight_color: "#fff", background_color: "#000", border_radius: "large", button_hover: "none")
# Stored values the model must refuse to compile.
cases << run(highlight_color: "red")
cases << run(background_color: "#ff00ff;}body{x:y")
cases << run(font: "Comic Sans")
cases << run(border_radius: "huge")
cases << run(button_hover: "spin")
cases << run(highlight_color: "#ffffff\n")

File.write(OUT, JSON.pretty_generate(cases.map { |input, output| { input:, output: } }) + "\n")
puts "wrote #{cases.size} cases"

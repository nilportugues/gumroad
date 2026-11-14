# frozen_string_literal: true

# Regenerate: docker/bundle exec rails runner nextjs/src/server/controllers/__fixtures__/generate-order-email-validity-golden.rb > order-email-validity.golden.json
# EmailFormatValidator.valid? for the addresses controllers/orders-validations.test.ts replays.
list = %w[a@b.co a@b.c nobody nobody@ nobody@example @example.com a@b..co a.b@c.io .a@b.co a.@b.co a..b@c.io user+tag@sub.example.com a@[1.2.3.4] a@[1.2.3] a@b-c.co a@-b.co a@b.c0m a@b.co. x@y.zz ab@c.d a(b@c.de a,b@c.de a:b@c.de a;b@c.de a<b@c.de a>b@c.de a[b@c.de a]b@c.de a"b@c.de a@b.CO A@B.Co a@b_c.co a_b@c.co a@1.2.co]
list += ['"q"@e.fg', '"a b"@c.de', 'a\\b@c.de', "a@" + ("b" * 250) + ".co", "a" * 64 + "@b.co", "a@b@c.co", "a@b.co" * 1, "é@b.co", "a@b.cö", "ab", "a@b", "@@", "a@b.c.d.ee"]
puts JSON.generate(list.index_with { |e| EmailFormatValidator.valid?(e) })

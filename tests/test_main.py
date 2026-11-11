import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from scrapling.parser import Selector

from src.main import (
    build_movie_meta,
    clean_object,
    dedupe_records,
    get_requested_review_type,
    map_api_review,
    normalize_movie_url,
    parse_critic_cards,
    parse_query_review_type,
    select_page_records,
)

CRITIC_CARD = '''
<review-card-critic data-review-id="1" top-critic>
  <a slot="name" href="/critic/jane_doe">Jane Doe</a>
  <a slot="publication" href="/profiles/publication/x">Daily Test</a>
  <span slot="timestamp">Mar 20, 2024</span>
  <span slot="rating"><score-icon-critics sentiment="POSITIVE"></score-icon-critics><span>4/5</span></span>
  <p slot="review">Smart <em>and</em> thrilling.</p>
  <a slot="review-link" href="https://example.com/full">Full</a>
</review-card-critic>
'''


class UrlTests(unittest.TestCase):
    def test_normalize_movie_url(self):
        self.assertEqual(normalize_movie_url('https://www.rottentomatoes.com/m/inception/reviews?type=user'),
                         'https://www.rottentomatoes.com/m/inception')
        self.assertEqual(normalize_movie_url('www.rottentomatoes.com/m/inception'),
                         'https://www.rottentomatoes.com/m/inception')
        self.assertEqual(normalize_movie_url('/m/inception'), 'https://www.rottentomatoes.com/m/inception')
        self.assertEqual(normalize_movie_url({'url': 'https://www.rottentomatoes.com/m/inception'}), 
                         'https://www.rottentomatoes.com/m/inception')
        self.assertIsNone(normalize_movie_url('https://example.com/m/inception'))
        self.assertIsNone(normalize_movie_url('https://www.rottentomatoes.com/critic/jane_doe'))
        self.assertIsNone(normalize_movie_url(''))

    def test_query_review_type(self):
        self.assertEqual(parse_query_review_type('https://www.rottentomatoes.com/m/x/reviews?type=user'), 'all-audience')
        self.assertEqual(parse_query_review_type('/m/x?type=verified_audience'), 'verified-audience')
        self.assertEqual(parse_query_review_type('/m/x?type=top_critics'), 'top-critics')
        self.assertEqual(parse_query_review_type('/m/x?type=all_critics'), 'all-critics')
        self.assertIsNone(parse_query_review_type('/m/x'))

    def test_requested_review_type(self):
        self.assertEqual(get_requested_review_type('top_critics', None), 'top-critics')
        self.assertEqual(get_requested_review_type('bogus', 'all-audience'), 'all-audience')
        self.assertEqual(get_requested_review_type('bogus', None), 'all-critics')
        self.assertEqual(get_requested_review_type(None, None), 'all-critics')


class CleanTests(unittest.TestCase):
    def test_clean_object(self):
        self.assertEqual(clean_object({'a': '  ', 'b': ' x ', 'c': None, 'd': False, 'e': [], 'f': {'g': ''}}),
                         {'b': 'x', 'd': False})
        self.assertIsNone(clean_object([]))


class MappingTests(unittest.TestCase):
    def test_critic_cards(self):
        meta = {'movieTitle': 'Test'}
        records = parse_critic_cards(Selector(f'<html>{CRITIC_CARD}</html>'), meta, 'all-critics')
        self.assertEqual(len(records), 1)
        record = records[0]
        self.assertEqual(record['reviewId'], '1')
        self.assertEqual(record['criticName'], 'Jane Doe')
        self.assertEqual(record['criticSlug'], 'jane_doe')
        self.assertEqual(record['publicationUrl'], 'https://www.rottentomatoes.com/profiles/publication/x')
        self.assertEqual(record['quote'], 'Smart and thrilling.')
        self.assertEqual(record['originalScore'], '4/5')
        self.assertEqual(record['scoreSentiment'], 'POSITIVE')
        self.assertIs(record['isTopReview'], True)
        self.assertIs(record['isFresh'], True)
        self.assertIs(record['isRotten'], False)

    def test_top_critic_filter_falls_back(self):
        page = Selector(f'<html>{CRITIC_CARD}</html>')
        params = {'type': 'critic', 'topOnly': True, 'verified': False}
        self.assertEqual(len(select_page_records(page, None, {}, 'top-critics', params)), 1)

    def test_api_review_mapping(self):
        critic = {
            'reviewId': '9',
            'scoreSentiment': 'NEGATIVE',
            'isTopReview': False,
            'reviewQuote': 'Not for me.',
            'publicationReviewUrl': 'https://example.com/r',
            'critic': {'DisplayName': 'John Roe', 'vanity': 'john-roe'},
            'publication': {'name': 'Paper', 'url': 'https://paper.example'},
        }
        record = map_api_review(critic, {'movieTitle': 'Test'}, 'all-critics', 2)
        self.assertEqual(record['source'], 'reviews-api')
        self.assertEqual(record['page'], 2)
        self.assertEqual(record['criticName'], 'John Roe')
        self.assertEqual(record['criticSlug'], 'john-roe')
        self.assertEqual(record['publicationName'], 'Paper')
        self.assertEqual(record['publicationUrl'], 'https://paper.example')
        self.assertIs(record['isTopReview'], False)
        self.assertNotIn('rating', record)

        audience = {
            'ratingId': 'r1',
            'rating': 'STAR_5',
            'review': 'Loved it',
            'displayName': 'Amy',
            'isVerified': True,
            'user': {'realm': 'RT'},
        }
        mapped = map_api_review(audience, {}, 'verified-audience', 1)
        self.assertEqual(mapped['rating'], 'STAR_5')
        self.assertEqual(mapped['userRealm'], 'RT')
        self.assertIs(mapped['isVerified'], True)

    def test_meta(self):
        vanity = {'title': 'Test', 'href': '/m/test', 'value': 'test', 'emsId': 'e1',
                  'lifecycleWindow': {'date': '2010-07-16', 'lifecycle': 'OUT_OF_THEATERS'}}
        scorecard = {'criticsScore': {'sentiment': 'POSITIVE', 'reviewCount': 10},
                     'audienceScore': {'sentiment': 'POSITIVE'}}
        page = Selector('<html><div id="critics-consensus">Critics Consensus Great. '
                        '<a>Read Critics Reviews</a></div></html>')
        meta = build_movie_meta(page, vanity, scorecard, None)
        self.assertEqual(meta['movieTitle'], 'Test')
        self.assertEqual(meta['movieUrl'], 'https://www.rottentomatoes.com/m/test')
        self.assertEqual(meta['tomatometerReviews'], 10)
        self.assertEqual(meta['criticsConsensus'], 'Great.')
        self.assertNotIn('tomatometerScore', {k: v for k, v in meta.items() if v is not None})

    def test_dedupe(self):
        records = [{'reviewId': '1'}, {'reviewId': '1'}, {'ratingId': '2'},
                   {'criticName': 'A', 'userDisplayName': None, 'quote': 'Q'},
                   {'criticName': 'A', 'quote': 'Q'}]
        self.assertEqual(len(dedupe_records(records)), 3)


if __name__ == '__main__':
    unittest.main()

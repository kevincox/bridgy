"""Task queue handlers.

TODO: cron job to find sources without seed poll tasks.
TODO: think about how to determine stopping point. can all sources return
comments in strict descending timestamp order? can we require/generate
monotonically increasing comment ids for all sources? 
TODO: check HRD consistency guarantees and change as needed
TODO BUG: Poll and propagate task names need to be unique (even for the same
e.g. source and last polled timestamp) so they can be
recreated. otherwise we get TombstonedTaskError.
"""

__author__ = ['Ryan Barrett <bridgy@ryanb.org>']

import datetime
import itertools
import logging
import re
import time

# need to import model class definitions since poll creates and saves entities.
import facebook
import googleplus
import twitter
import util
import wordpress

from google.appengine.ext import db
from google.appengine.api import taskqueue
from google.appengine.ext import webapp
from google.appengine.ext.webapp.util import run_wsgi_app

import appengine_config

TASK_NAME_HEADER = 'X-AppEngine-TaskName'

# all concrete destination model classes
DESTINATIONS = ['WordPressSite']


class TaskHandler(webapp.RequestHandler):
  """Task handler base class. Includes common utilities.

  Attributes:
    now: callable replacement for datetime.datetime.now(). Returns the current
      datetime.
  """

  def __init__(self, *args, **kwargs):
    super(TaskHandler, self).__init__(*args)
    self.now = kwargs.pop('now', datetime.datetime.now)

  def task_name(self):
    """Returns this task's name.

    Raises KeyError if it doesn't have a name.
    """
    return self.request.headers[TASK_NAME_HEADER]


class Poll(TaskHandler):
  """Task handler that fetches and processes new comments from a single source.

  Task name is '[serialized source key]_[last polled datetime]', where last
  polled time is formatted YYYY-MM-DD-HH-MM-SS. (This is isoformat() with -
  as the separator for time as well as date.)

  Inserts a propagate task for each comment that hasn't been seen before.
  """

  TASK_NAME_RE = re.compile('^(.+)_(.+)$')
  TASK_COUNTDOWN = datetime.timedelta(hours=1)

  def post(self):
    match = self.TASK_NAME_RE.match(self.task_name())
    key = match.group(1)
    source = db.get(key)

    if match.group(2) != source.last_polled.strftime(util.POLL_TASK_DATETIME_FORMAT):
      logging.warning('duplicate poll task! deferring to the other task.')
      return

    logging.debug('Polling source %s' % source.key().name())

    # itertools.chain flattens.
    dests = itertools.chain(*[list(db.GqlQuery('SELECT * FROM %s' % cls))
                              for cls in DESTINATIONS])
    posts_and_dests = []

    for post, url in source.get_posts():
      logging.debug('Looking for destination for link: %s' % url)
      # can't use this string prefix query code because we want the property
      # that's a prefix of the filter value, not vice versa.
      # query = db.GqlQuery(
      #   'SELECT * FROM WordPressSite WHERE url = :1 AND url <= :2',
      #   url, url + u'\ufffd')
      dest = [d for d in dests if url.startswith(d.url)]
      assert len(dest) <= 1
      if dest:
        dest = dest[0]
        logging.debug('Found destination: %s' % dest.key().name())
        posts_and_dests.append((post, dest))

    for comment in source.get_comments(posts_and_dests):
      comment.get_or_save()

    source.last_polled = self.now()
    taskqueue.add(name=util.make_poll_task_name(source), queue_name='poll',
                  countdown=self.TASK_COUNTDOWN.seconds)
    source.save()


class Propagate(TaskHandler):
  """Task handler that propagates a single comment.

  Task name is the serialized Comment key.
  """

  # request deadline (10m) plus some padding
  LEASE_LENGTH = datetime.timedelta(minutes=12)

  ERROR_HTTP_RETURN_CODE = 417  # Expectation Failed

  def post(self):
    try:
      comment = self.lease_comment()
      if comment:
        comment.dest.add_comment(comment)
        self.complete_comment()
    except:
      logging.exception('Propagate task failed')
      self.release_comment()
      raise

  @db.transactional
  def lease_comment(self):
    """Attempts to acquire and lease the comment entity.

    Returns the Comment on success, otherwise None.

    TODO: unify with complete_comment
    """
    comment = db.get(self.task_name())

    if comment is None:
      self.fail('no comment entity!')
    elif comment.status == 'complete':
      # let this response return 200 and finish
      logging.warning('duplicate task already propagated comment')
    elif comment.status == 'processing' and self.now() < comment.leased_until:
      self.fail('duplicate task is currently processing!')
    else:
      assert comment.status in ('new', 'processing')
      comment.status = 'processing'
      comment.leased_until = self.now() + self.LEASE_LENGTH
      comment.save()
      return comment

  @db.transactional
  def complete_comment(self):
    """Attempts to mark the comment entity completed.

    Returns True on success, False otherwise.
    """
    comment = db.get(self.task_name())

    if comment is None:
      self.fail('comment entity disappeared!')
    elif comment.status == 'complete':
      # let this response return 200 and finish
      logging.warning('comment stolen and finished. did my lease expire?')
    elif comment.status == 'new':
      self.fail('comment went backward from processing to new!')
    else:
      assert comment.status == 'processing'
      comment.status = 'complete'
      comment.save()
      return True

    return False

  @db.transactional
  def release_comment(self):
    """Attempts to unlease the comment entity.
    """
    comment = db.get(self.task_name())
    if comment.status == 'processing':
      comment.status = 'new'
      comment.leased_until = None
      comment.save()

  def fail(self, message):
    """Fills in an error response status code and message.
    """
    self.error(self.ERROR_HTTP_RETURN_CODE)
    logging.error(message)
    self.response.out.write(message)


application = webapp.WSGIApplication([
    ('/_ah/queue/poll', Poll),
    ('/_ah/queue/propagate', Propagate),
    ], debug=appengine_config.DEBUG)

def main():
  run_wsgi_app(application)


if __name__ == '__main__':
  main()

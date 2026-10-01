// Facade for the email service. The implementation lives in ./email/*; this
// module keeps the long-standing export surface (and require path) that the
// CLI, workflows and tests use.

const { _expandRelativeDate, _parseDateInput } = require("./email/dates");
const { _deadlineExceeded, _raceTimeout } = require("./email/deadline");
const { listEmails, listFolders } = require("./email/list");
const { searchEmails } = require("./email/search");
const { showEmail, showEmails, showEmailsResolved, resolveEmailFolder } = require("./email/show");
const { markEmails, deleteEmails, flagEmail, moveEmails } = require("./email/mutations");
const { sendEmail, replyEmail, forwardEmail } = require("./email/send");
const { downloadAttachments } = require("./email/attachments");
const { watchFolder } = require("./email/watch");

module.exports = {
  listEmails,
  searchEmails,
  showEmail,
  showEmails,
  showEmailsResolved,
  resolveEmailFolder,
  _parseDateInput,
  _expandRelativeDate,
  _deadlineExceeded,
  _raceTimeout,
  watchFolder,
  markEmails,
  deleteEmails,
  sendEmail,
  replyEmail,
  forwardEmail,
  listFolders,
  downloadAttachments,
  flagEmail,
  moveEmails,
};

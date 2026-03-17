'use strict';

module.exports = {
  id: 'docs-companion-plugin',
  register() {
    return {
      hooks: ['post-change-docs-review'],
      summary: 'Remind the engine to update or explain operator-facing docs changes.',
    };
  },
};

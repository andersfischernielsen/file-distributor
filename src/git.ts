import { Context, Probot } from 'probot';
import { RepositoryDetails, Template } from './types';

const baseBranchName = 'centralized-templates';
const reducedBranchName = `heads/${baseBranchName}`;
const fullBranchName = `refs/${reducedBranchName}`;

const getOrCreateNewBranch = (app: Probot, context: Context<'push'>) => async (repository: RepositoryDetails, baseBranchRef: string) => {
  try {
    app.log.debug(`Creating new branch on SHA: '${baseBranchRef}'.`);
    const newBranch = (await context.octokit.git.createRef({ ...repository, ref: fullBranchName, sha: baseBranchRef })).data;
    app.log.debug(`Created new branch with ref: '${newBranch.ref}'.`);
    return newBranch;
  } catch {
    app.log.debug(`Failed to create a new branch with ref: '${fullBranchName}'.`);
    app.log.debug(`Fetching existing branch with ref: '${reducedBranchName}'.`);
    const foundBranch = (await context.octokit.git.getRef({ ...repository, ref: reducedBranchName })).data;
    app.log.debug(`Found new branch with ref: '${foundBranch.ref}'.`);
    app.log.debug(`Updating branch to match '${baseBranchRef}'.`);
    const updatedRef = (await context.octokit.git.updateRef({
      ...repository,
      ref: reducedBranchName,
      sha: baseBranchRef,
      force: true,
    })).data;
    app.log.debug(`Updated '${reducedBranchName}' to '${updatedRef.ref}'.`);

    return updatedRef;
  }
};

const createTreeWithChanges = (app: Probot, context: Context<'push'>) => (templates: Template[], repository: RepositoryDetails) => async (treeSha: string) => {
  const tree = templates.map((template) => ({
    path: template.path,
    mode: '100644',
    type: 'blob',
    content: template.contents,
  }));

  app.log.debug(`Fetching existing trees from '${treeSha}'.`);
  const existingTree = (await context.octokit.git.getTree({ ...repository, tree_sha: treeSha })).data.tree;
  app.log.debug('Creating git tree with modified templates.');
  const createdTree = await context.octokit.git.createTree({ ...repository, tree: [...tree, ...existingTree] as any });
  app.log.debug(`Created git tree with SHA '${createdTree.data.sha}'.`);
  return createdTree;
};

const createCommitWithChanges = (app: Probot, context: Context<'push'>) => (repository: RepositoryDetails, title: string) => async (currentCommit: { data: { sha: string; }; }, createdTree: { data: { sha: string; }; }) => {
  app.log.debug('Creating git commit with modified templates.');
  const newCommit = await context.octokit.git.createCommit({
    ...repository,
    message: title,
    tree: createdTree.data.sha,
    parents: [currentCommit.data.sha],
  });
  app.log.debug(`Created git commit with SHA '${newCommit.data.sha}'.`);

  return newCommit;
};

const createOrUpdateExistingPullRequest = (app: Probot, context: Context<'push'>) => async (repository: RepositoryDetails, details: { title: string; description: string; }, baseBranch: string) => {
  const { title, description } = details;

  const openPullRequests = (await context.octokit.pulls.list({
    ...repository,
    head: fullBranchName,
    state: 'open',
  })).data;
  app.log.debug(`Found ${openPullRequests.length} open PRs.`);

  const toUpdate = openPullRequests.shift();

  if (!toUpdate) {
    app.log.debug('Creating PR.');
    const created = await context.octokit.pulls.create({
      ...repository,
      title,
      body: description,
      head: fullBranchName,
      base: baseBranch,
    });
    app.log.debug(`Created PR #${created.data.number}.`);

    return created;
  }

  await Promise.all(openPullRequests.map(async (pr) => {
    app.log.debug(`Closing PR #${pr.number}.`);
    await context.octokit.pulls.update({
      ...repository,
      pull_number: pr.number,
      state: 'closed',
    });
    app.log.debug(`Closed PR #${pr.number}.`);
  }));

  app.log.debug(`Updating PR #${toUpdate.number}.`);
  const updated = await context.octokit.pulls.update({
    ...repository,
    pull_number: toUpdate.number,
    head: fullBranchName,
    state: 'open',
  });
  app.log.debug(`Updated PR #${updated.data.number}.`);

  return updated;
};

const createOrUpdatePullRequest = (app: Probot, context: Context<'push'>) => async (repository: RepositoryDetails, details: { title: string; description: string; }, baseBranch: string, automerge?: boolean) => {
  const created = await createOrUpdateExistingPullRequest(app, context)(repository, details, baseBranch);

  if (automerge) {
    app.log.debug(`Attempting automerge of PR #${created.data.number}.`);
    await context.octokit.rest.pulls.merge({
      ...repository,
      pull_number: created.data.number,
      merge_method: 'squash',
    });
    app.log.debug(`Merged PR #${created.data.number}.`);
  }

  return created;
};

const updateBranch = (app: Probot, context: Context<'push'>) => async (newBranch: { ref: string; }, newCommit: { data: { sha: string; }; }, repository: RepositoryDetails) => {
  app.log.debug(`Setting new branch ref '${newBranch.ref}' to commit '${newCommit.data.sha}'.`);
  const updatedRef = await context.octokit.git.updateRef({
    ...repository,
    ref: reducedBranchName,
    sha: newCommit.data.sha,
    force: true,
  });
  app.log.debug(`Updated new branch ref '${updatedRef.data.ref}'.`);
};

export default (app: Probot, context: Context<'push'>) => async (repository: RepositoryDetails, templates: Template[]) => {
  const prDetails = {
    title: 'Update templates based on repository configuration',
    description: 'Update templates based on repository configuration.',
  };

  app.log.debug('Fetching base branch.');
  const baseBranch = (await context.octokit.repos.get({ ...repository })).data.default_branch;
  app.log.debug(`Fetching base branch ref 'heads/${baseBranch}'.`);
  const baseBranchRef = (await context.octokit.git.getRef({ ...repository, ref: `heads/${baseBranch}` })).data.object.sha;

  const newBranch = await getOrCreateNewBranch(app, context)(repository, baseBranchRef);

  app.log.debug('Determining current commit.');
  const currentCommit = await context.octokit.git.getCommit({ ...repository, commit_sha: newBranch.object.sha });

  app.log.debug(`Using base branch '${baseBranch}'.`);
  app.log.debug(`Using base commit '${currentCommit.data.sha}'.`);

  const createdTree = await createTreeWithChanges(app, context)(templates, repository)(baseBranchRef);
  const newCommit = await createCommitWithChanges(app, context)(repository, prDetails.title)(currentCommit, createdTree);
  await updateBranch(app, context)(newBranch, newCommit, repository);
  const pullRequest = await createOrUpdatePullRequest(app, context)(repository, prDetails, baseBranch);

  return pullRequest.data.number;
};
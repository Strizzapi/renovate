import is from '@sindresorhus/is';
import { load } from 'js-yaml';
import { PlatformId } from '../../constants';
import { id as githubTagsId } from '../../datasource/github-tags';
import { id as gitlabTagsId } from '../../datasource/gitlab-tags';
import { logger } from '../../logger';
import { SkipReason } from '../../types';
import { find } from '../../util/host-rules';
import { regEx } from '../../util/regex';
import type { PackageDependency, PackageFile } from '../types';
import {
  matchesPrecommitConfigHeuristic,
  matchesPrecommitDependencyHeuristic,
} from './parsing';
import { PreCommitConfig } from './types';

function isEmptyObject(obj: any): boolean {
  return Object.keys(obj).length === 0 && obj.constructor === Object;
}

/**
 * Determines the datasource(id) to be used for this dependency
 * @param repository the full git url, ie git@github.com/user/project.
 *        Used in debug statements to clearly indicate the related dependency.
 * @param hostname the hostname (ie github.com)
 *        Used to determine which renovate datasource should be used.
 *        Is matched literally against `github.com` and `gitlab.com`.
 *        If that doesn't match, `hostRules.find()` is used to find related sources.
 *        In that case, the hostname is passed on as registryUrl to the corresponding datasource.
 */
function determineDatasource(
  repository: string,
  hostname: string
): { datasource?: string; registryUrls?: string[]; skipReason?: SkipReason } {
  if (hostname === 'github.com') {
    logger.debug({ repository, hostname }, 'Found github dependency');
    return { datasource: githubTagsId };
  }
  if (hostname === 'gitlab.com') {
    logger.debug({ repository, hostname }, 'Found gitlab dependency');
    return { datasource: gitlabTagsId };
  }
  const hostUrl = 'https://' + hostname;
  const res = find({ url: hostUrl });
  if (isEmptyObject(res)) {
    // 1 check, to possibly prevent 3 failures in combined query of hostType & url.
    logger.debug(
      { repository, hostUrl },
      'Provided hostname does not match any hostRules. Ignoring'
    );
    return { skipReason: 'unknown-registry', registryUrls: [hostname] };
  }
  for (const [hostType, sourceId] of [
    [PlatformId.Gitea, gitlabTagsId],
    [PlatformId.Github, githubTagsId],
    [PlatformId.Gitlab, gitlabTagsId],
  ]) {
    if (!isEmptyObject(find({ hostType, url: hostUrl }))) {
      logger.debug(
        { repository, hostUrl, hostType },
        `Provided hostname matches a ${hostType} hostrule.`
      );
      return { datasource: sourceId, registryUrls: [hostname] };
    }
  }
  logger.debug(
    { repository, registry: hostUrl },
    'Provided hostname did not match any of the hostRules of hostType gitea,github nor gitlab'
  );
  return { skipReason: 'unknown-registry', registryUrls: [hostname] };
}

function extractDependency(
  tag: string,
  repository: string
): {
  depName?: string;
  depType?: string;
  datasource?: string;
  lookupName?: string;
  skipReason?: SkipReason;
  currentValue?: string;
} {
  logger.debug({ tag }, 'Found version');

  const urlMatchers = [
    // This splits "http://my.github.com/user/repo" -> "my.github.com" "user/repo
    regEx('^https?:\\/\\/(?<hostname>[^\\/]+)\\/(?<depName>\\S*)'),
    // This splits "git@private.registry.com:user/repo" -> "private.registry.com" "user/repo
    regEx('^git@(?<hostname>[^:]+):(?<depName>\\S*)'),
    // This split "git://github.com/pre-commit/pre-commit-hooks" -> "github.com" "pre-commit/pre-commit-hooks"
    regEx(/^git:\/\/(?<hostname>[^/]+)\/(?<depName>\S*)/),
  ];
  for (const urlMatcher of urlMatchers) {
    const match = urlMatcher.exec(repository);
    if (match) {
      const hostname = match.groups.hostname;
      const depName = match.groups.depName.replace(regEx(/\.git$/i), ''); // TODO 12071
      const sourceDef = determineDatasource(repository, hostname);
      return {
        ...sourceDef,
        depName,
        depType: 'repository',
        lookupName: depName,
        currentValue: tag,
      };
    }
  }
  logger.info(
    { repository },
    'Could not separate hostname from full dependency url.'
  );
  return {
    depName: undefined,
    depType: 'repository',
    datasource: undefined,
    lookupName: undefined,
    skipReason: 'invalid-url',
    currentValue: tag,
  };
}

/**
 * Find all supported dependencies in the pre-commit yaml object.
 *
 * @param precommitFile the parsed yaml config file
 */
function findDependencies(
  precommitFile: PreCommitConfig
): Array<PackageDependency> {
  if (!precommitFile.repos) {
    logger.debug(`No repos section found, skipping file`);
    return [];
  }
  const packageDependencies = [];
  precommitFile.repos.forEach((item) => {
    if (matchesPrecommitDependencyHeuristic(item)) {
      logger.trace(item, 'Matched pre-commit dependency spec');
      const repository = String(item.repo);
      const tag = String(item.rev);
      const dep = extractDependency(tag, repository);

      packageDependencies.push(dep);
    } else {
      logger.trace(item, 'Did not find pre-commit repo spec');
    }
  });
  return packageDependencies;
}

export function extractPackageFile(
  content: string,
  filename: string
): PackageFile | null {
  type ParsedContent = Record<string, unknown> | PreCommitConfig;
  let parsedContent: ParsedContent;
  try {
    parsedContent = load(content, { json: true }) as ParsedContent;
  } catch (err) {
    logger.debug({ filename, err }, 'Failed to parse pre-commit config YAML');
    return null;
  }
  if (!is.plainObject<Record<string, unknown>>(parsedContent)) {
    logger.warn(
      { filename },
      `Parsing of pre-commit config YAML returned invalid result`
    );
    return null;
  }
  if (!matchesPrecommitConfigHeuristic(parsedContent)) {
    logger.debug(
      { filename },
      `File does not look like a pre-commit config file`
    );
    return null;
  }
  try {
    const deps = findDependencies(parsedContent);
    if (deps.length) {
      logger.trace({ deps }, 'Found dependencies in pre-commit config');
      return { deps };
    }
  } catch (err) /* istanbul ignore next */ {
    logger.warn({ filename, err }, 'Error scanning parsed pre-commit config');
  }
  return null;
}

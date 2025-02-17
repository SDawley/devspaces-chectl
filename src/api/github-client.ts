/**
 * Copyright (c) 2019-2021 Red Hat, Inc.
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 *
 * Contributors:
 *   Red Hat, Inc. - initial API and implementation
 */

import { Octokit } from '@octokit/rest'

export const ECLIPSE_CHE_ORG = 'eclipse-che'
export const ECLIPSE_CHE_INCUBATOR_ORG = 'che-incubator'

export const CHE_OPERATOR_REPO = 'devspaces-operator'
export const CHECTL_REPO = 'dsc'

export interface TagInfo {
  name: string
  commit: {
    sha: string
    url: string
  }
  zipball_url: string
}

export class CheGithubClient {
  private readonly octokit: Octokit

  constructor() {
    this.octokit = new Octokit({
      baseUrl: 'https://api.github.com',
      userAgent: 'dsc',
      auth: process.env.GITHUB_TOKEN,
    })
  }

  /**
   * Returns version (tag) information based on installer and version string (e.g. 7.19.2).
   */
  async getTemplatesTagInfo(installer: string, version?: string): Promise<TagInfo | undefined> {
    if (installer === 'operator' || installer === 'olm') {
      return this.getTagInfoByVersion(ECLIPSE_CHE_ORG, CHE_OPERATOR_REPO, version)
    }
    throw new Error(`Unsupported installer: ${installer}`)
  }

  /**
   * Gets last 50 tags from the given repository.
   * @param owner oerganization of the repository
   * @param repo repository name to list tag in
   * @param prefix return only tags that starts with given prefix
   */
  private async listLatestTags(owner: string, repo: string, prefix = ''): Promise<TagInfo[]> {
    const response = await this.octokit.repos.listTags({ owner, repo, per_page: 50 })
    const tags = response.data
    if (prefix) {
      return tags.filter(tag => tag.name.startsWith(prefix))
    }
    return tags
  }

  /**
   * Gets tag info if it exists.
   * @param owner oerganization of the repository
   * @param repo repository name to search for the tag in
   * @param tagName name of the tag
   */
  private async getTag(owner: string, repo: string, tagName: string): Promise<TagInfo | undefined> {
    try {
      const tagRefResp = await this.octokit.git.getRef({ owner, repo, ref: `tags/${tagName}` })
      const tagRef = tagRefResp.data
      const downloadUrlResp = await this.octokit.repos.downloadZipballArchive({ owner, repo, ref: tagRef.object.sha })
      // Simulate tag info
      return {
        name: tagName,
        commit: {
          sha: tagRef.object.sha,
          url: tagRef.object.url,
        },
        zipball_url: downloadUrlResp.url,
      }
    } catch (e) {
      if (e.status !== 404) {
        throw e
      }
      // Not found, return undefined
    }
  }

  /**
   * Returns latest commit information in tag format.
   * @param owner oerganization of the repository
   * @param repo repository name to get the latest commit from
   */
  private async getLastCommitInfo(owner: string, repo: string): Promise<TagInfo> {
    const listCommitsResponse = await this.octokit.repos.listCommits({ owner, repo, per_page: 1 })
    if (listCommitsResponse.status !== 200) {
      throw new Error(`Failed to get list of commits from the repository '${repo}'. Request: ${listCommitsResponse.url}, response: ${listCommitsResponse.status}`)
    }
    const lastCommit = listCommitsResponse.data[0]

    const downloadZipResponse = await this.octokit.repos.downloadZipballArchive({
      owner,
      repo,
      ref: lastCommit.sha!,
    })
    const zipball_url = downloadZipResponse.url

    // Simiulate tag info to have similar return type
    return {
      name: 'next',
      commit: {
        sha: lastCommit.sha!,
        url: lastCommit.commit.url,
      },
      zipball_url,
    }
  }

  /**
   * Returns tag/commit information about given version.
   * The informaton includes zip archive download link.
   * If non-existing version is given, then undefined will be returned.
   * @param owner oerganization of the repository
   * @param repo repository name
   * @param version version or version prefix. If only prefix is given, the latest one that match will be choosen.
   */
  private async getTagInfoByVersion(owner: string, repo: string, version?: string): Promise<TagInfo | undefined> {
    if (!version || version === 'latest' || version === 'stable') {
      const tags = await this.listLatestTags(owner, repo)
      return this.getLatestTag(tags)
    } else if (version === 'next' || version === 'nightly') {
      return this.getLastCommitInfo(owner, repo)
    } else {
      // User might provide a version directly or only version prefix, e.g. 7.15
      // Some old tags might have 'v' prefix
      if (version.startsWith('v')) {
        // Remove 'v' prefix
        version = version.substr(1)
      }
      let tagInfo = await this.getTagInfoByVersionPrefix(owner, repo, version)
      if (!tagInfo) {
        // Try to add 'v' prefix
        tagInfo = tagInfo = await this.getTagInfoByVersionPrefix(owner, repo, 'v' + version)
      }
      return tagInfo
    }
  }

  /**
   * Helper for getTagInfoByVersion
   * Gets tag by exact match or latest tag with given prefix
   * @param owner oerganization of the repository
   * @param repo repository name
   * @param versionPrefix version or version prefix, e.g. 7.22.0 or 7.18
   */
  private async getTagInfoByVersionPrefix(owner: string, repo: string, versionPrefix: string): Promise<TagInfo | undefined> {
    const tagInfo = await this.getTag(owner, repo, versionPrefix)
    if (tagInfo) {
      // Exact match found
      return tagInfo
    }

    const tags = await this.listLatestTags(repo, versionPrefix)
    if (tags.length === 0) {
      // Wrong version is given
      return
    } else if (tags.length === 1) {
      return tags[0]
    } else {
      // Several tags match the given version (e.g. 7.15.0 and 7.15.1 match 7.15).
      // Find the latest one.
      return this.getLatestTag(tags)
    }
  }

  /**
   * Finds the latest tag of format x.y.z, where x,y and z are numbers.
   * @param tags repository tags list returned by octokit
   */
  public getLatestTag(tags: TagInfo[]): TagInfo {
    if (tags.length === 0) {
      throw new Error('Tag list should not be empty')
    }

    const sortedSemanticTags = this.sortSemanticTags(tags)
    return sortedSemanticTags[0]
  }

  /**
   * Sorts given tags. First is the latest.
   * All tags should use semantic versioning in form x.y.z, where x,y and z are numbers.
   * If a tag is not in the descrbed above format, it will be ignored.
   * @param tags list of tags to sort
   */
  private sortSemanticTags(tags: TagInfo[]): TagInfo[] {
    interface SemanticTagData {
      major: number
      minor: number
      patch: number
      data: TagInfo
    }

    const semanticTags: SemanticTagData[] = tags.reduce<SemanticTagData[]>((acceptedTags, tagInfo, _index: number, _all: TagInfo[]) => {
      // Remove 'v' prefix if any
      if (tagInfo.name.startsWith('v')) {
        tagInfo.name = tagInfo.name.substring(1)
      }

      const versionComponents = tagInfo.name.split('.')
      // Accept the tag only if it has format x.y.z and z has no suffix (like '-RC2' or '-5e87ab1')
      if (versionComponents.length === 3 && (parseInt(versionComponents[2], 10).toString() === versionComponents[2])) {
        acceptedTags.push({
          major: parseInt(versionComponents[0], 10),
          minor: parseInt(versionComponents[1], 10),
          patch: parseInt(versionComponents[2], 10),
          data: tagInfo,
        })
      }
      return acceptedTags
    }, [])
    if (semanticTags.length === 0) {
      // Should never happen
      throw new Error('There is no semantic tags')
    }

    const sortedSemanticTags = semanticTags.sort((semTagA: SemanticTagData, semTagB: SemanticTagData) => {
      if (semTagA.major !== semTagB.major) {
        return semTagB.major - semTagA.major
      } else if (semTagA.minor !== semTagB.minor) {
        return semTagB.minor - semTagA.minor
      } else if (semTagA.patch !== semTagB.patch) {
        return semTagB.patch - semTagA.patch
      } else {
        return 0
      }
    })

    return sortedSemanticTags.map(tag => tag.data)
  }

  private async getCommitData(owner: string, repo: string, commitId: string) {
    const commitDataResponse = await this.octokit.repos.getCommit({ owner, repo, ref: commitId })
    if (commitDataResponse.status !== 200) {
      throw new Error(`Failed to get commit data from the repository '${repo}'. Request: ${commitDataResponse.url}, response: ${commitDataResponse.status}`)
    }
    return commitDataResponse.data
  }

  /**
   * Returns date of the given commit
   * @param owner oerganization of the repository
   * @param repo repository name
   * @param commitId ID of commit to get date for
   */
  async getCommitDate(owner: string, repo: string, commitId: string): Promise<string> {
    const commitData = await this.getCommitData(owner, repo, commitId)
    if (!commitData.commit.committer || !commitData.commit.committer.date) {
      throw new Error(`Failed to read '${commitId}' commit date`)
    }
    return commitData.commit.committer.date
  }
}

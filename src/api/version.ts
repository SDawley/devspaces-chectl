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

import axios from 'axios'
import { cli } from 'cli-ux'
import * as fs from 'fs-extra'
import * as https from 'https'
import * as path from 'path'
import * as semver from 'semver'
import { CHECTL_REPO, CheGithubClient, ECLIPSE_CHE_INCUBATOR_ORG } from '../api/github-client'
import { CHECTL_PROJECT_NAME } from '../constants'
import { getProjectName, getProjectVersion, isKubernetesPlatformFamily, sleep } from '../util'
import { ChectlContext } from './context'
import { KubeHelper } from './kube'
import execa = require('execa')
import Listr = require('listr')

export const CHECTL_DEVELOPMENT_VERSION = '0.0.2'

const UPDATE_INFO_FILENAME = 'update-info.json'
interface NewVersionInfoData {
  latestVersion: string
  // datetime of last check in milliseconds
  lastCheck: number
}
const A_DAY_IN_MS = 24 * 60 * 60 * 1000

export namespace VersionHelper {
  export const MINIMAL_OPENSHIFT_VERSION = '4.8'
  export const MINIMAL_K8S_VERSION = '1.19'

  export function getOpenShiftCheckVersionTask(flags: any): Listr.ListrTask {
    return {
      title: 'Check OpenShift version',
      task: async (ctx: any, task: any) => {
        const actualVersion = await getOpenShiftVersion()
        if (actualVersion) {
          task.title = `${task.title}: [${actualVersion}]`
        } else if (ctx[ChectlContext.IS_OPENSHIFT]) {
          task.title = `${task.title}: [4.x]`
        }

        if (!flags['skip-version-check'] && actualVersion) {
          const checkPassed = checkMinimalVersion(actualVersion, MINIMAL_OPENSHIFT_VERSION)
          if (!checkPassed) {
            throw getMinimalVersionError(actualVersion, MINIMAL_OPENSHIFT_VERSION, 'OpenShift')
          }
        }
      },
    }
  }
  export function getK8sCheckVersionTask(flags: any): Listr.ListrTask {
    return {
      title: 'Check Kubernetes version',
      task: async (_ctx: any, task: any) => {
        let actualVersion
        switch (flags.platform) {
        case 'openshift':
        case 'crc':
          actualVersion = await getK8sVersionWithOC()
          break
        default:
          actualVersion = await getK8sVersionWithKubectl()
        }

        if (actualVersion) {
          task.title = `${task.title}: [Found ${actualVersion}]`
        } else {
          task.title = `${task.title}: [Unknown]`
        }

        if (isKubernetesPlatformFamily(flags.platform) && !flags['skip-version-check'] && actualVersion) {
          const checkPassed = checkMinimalK8sVersion(actualVersion)
          if (!checkPassed) {
            throw getMinimalVersionError(actualVersion, MINIMAL_K8S_VERSION, 'Kubernetes')
          }
        }
      },
    }
  }

  export async function getOpenShiftVersion(): Promise<string | undefined> {
    return getVersionWithOC('openshift ')
  }

  export async function getK8sVersionWithOC(): Promise<string | undefined> {
    return getVersionWithOC('kubernetes ')
  }

  export async function getK8sVersionWithKubectl(): Promise<string | undefined> {
    return getVersionWithKubectl('Server Version: ')
  }

  export function checkMinimalK8sVersion(actualVersion: string): boolean {
    return checkMinimalVersion(actualVersion, MINIMAL_K8S_VERSION)
  }

  export function checkMinimalOpenShiftVersion(actualVersion: string): boolean {
    return checkMinimalVersion(actualVersion, MINIMAL_OPENSHIFT_VERSION)
  }

  /**
   * Compare versions and return true if actual version is greater or equal to minimal.
   * The comparison will be done by major and minor versions.
   */
  export function checkMinimalVersion(actual: string, minimal: string): boolean {
    actual = removeVPrefix(actual)
    let vers = actual.split('.')
    const actualMajor = parseInt(vers[0], 10)
    const actualMinor = parseInt(vers[1], 10)

    minimal = removeVPrefix(minimal)
    vers = minimal.split('.')
    const minimalMajor = parseInt(vers[0], 10)
    const minimalMinor = parseInt(vers[1], 10)

    return (actualMajor > minimalMajor || (actualMajor === minimalMajor && actualMinor >= minimalMinor))
  }

  export function getMinimalVersionError(actualVersion: string, minimalVersion: string, component: string): Error {
    return new Error(`The minimal supported version of ${component} is '${minimalVersion} but '${actualVersion}' was found. To bypass version check use '--skip-version-check' flag.`)
  }

  async function getVersionWithOC(versionPrefix: string): Promise<string | undefined> {
    const command = 'oc'
    const args = ['version']
    const { stdout } = await execa(command, args, { timeout: 60000 })
    return stdout.split('\n').filter(value => value.startsWith(versionPrefix)).map(value => value.substring(versionPrefix.length))[0]
  }

  async function getVersionWithKubectl(versionPrefix: string): Promise<string | undefined> {
    const command = 'kubectl'
    const args = ['version', '--short']
    const { stdout } = await execa(command, args, { timeout: 60000 })
    return stdout.split('\n').filter(value => value.startsWith(versionPrefix)).map(value => value.substring(versionPrefix.length))[0]
  }

  /**
   * Returns Red Hat OpenShift Dev Spaces version.
   */
  export async function getCheVersion(flags: any): Promise<string> {
    const kube = new KubeHelper(flags)
    for (let i = 0; i < 10; i++) {
      const cheCluster = await kube.getCheClusterV1(flags.chenamespace)
      if (cheCluster) {
        if (cheCluster.status.cheVersion) {
          return cheCluster.status.cheVersion
        }
      }

      await sleep(1000) // wait a bit, operator has not updated version yet
    }

    return ''
  }

  /**
   * Returns latest dsc version for the given channel.
   */
  export async function getLatestChectlVersion(channel: string): Promise<string | undefined> {
    if (getProjectName() !== CHECTL_PROJECT_NAME) {
      return
    }

    const axiosInstance = axios.create({
      httpsAgent: new https.Agent({}),
    })

    try {
      const { data } = await axiosInstance.get(`https://che-incubator.github.io/dsc/channels/${channel}/linux-x64`)
      return data.version
    } catch {
      return
    }
  }

  /**
   * Checks whether there is an update available for current dsc.
   */
  export async function isChectlUpdateAvailable(cacheDir: string, forceRecheck = false): Promise<boolean> {
    // Do not use ctx inside this function as the function is used from hook where ctx is not yet defined.

    if (getProjectName() !== CHECTL_PROJECT_NAME) {
      // Do nothing for dsc flavors
      return false
    }

    const currentVersion = getProjectVersion()
    if (currentVersion === CHECTL_DEVELOPMENT_VERSION) {
      // Skip it, dsc is built from source
      return false
    }

    const channel = currentVersion.includes('next') ? 'next' : 'stable'
    const newVersionInfoFilePath = path.join(cacheDir, `${channel}-${UPDATE_INFO_FILENAME}`)
    let newVersionInfo: NewVersionInfoData = {
      latestVersion: '0.0.0',
      lastCheck: 0,
    }
    if (await fs.pathExists(newVersionInfoFilePath)) {
      try {
        newVersionInfo = (await fs.readJson(newVersionInfoFilePath, { encoding: 'utf8' })) as NewVersionInfoData
      } catch {
        // file is corrupted
      }
    }

    // Check cache, if it is already known that newer version available
    let isCachedNewerVersionAvailable = false
    try {
      isCachedNewerVersionAvailable = await gtChectlVersion(newVersionInfo.latestVersion, currentVersion)
    } catch (error) {
      // not a version (corrupted data)
      cli.debug(`Failed to compare versions '${newVersionInfo.latestVersion}' and '${currentVersion}': ${error}`)
    }

    const now = Date.now()
    const isCacheExpired = now - newVersionInfo.lastCheck > A_DAY_IN_MS
    if (forceRecheck || (!isCachedNewerVersionAvailable && isCacheExpired)) {
      // Cached info is expired. Fetch actual info about versions.
      // undefined cannot be returned from getLatestChectlVersion as 'is flavor' check was done before.
      const latestVersion = (await getLatestChectlVersion(channel))
      // if request failed (GitHub endpoint is not available) then
      // assume update is not available
      if (!latestVersion) {
        return false
      }
      newVersionInfo = { latestVersion, lastCheck: now }
      await fs.writeJson(newVersionInfoFilePath, newVersionInfo, { encoding: 'utf8' })
      try {
        return gtChectlVersion(newVersionInfo.latestVersion, currentVersion)
      } catch (error) {
        // not to fail unexpectedly
        cli.debug(`Failed to compare versions '${newVersionInfo.latestVersion}' and '${currentVersion}': ${error}`)
        return false
      }
    }

    // Information whether a newer version available is already in cache
    return isCachedNewerVersionAvailable
  }

  /**
   * Returns true if verA > verB
   */
  export async function gtChectlVersion(verA: string, verB: string): Promise<boolean> {
    return (await compareChectlVersions(verA, verB)) > 0
  }

  /**
   * Retruns:
   *  1 if verA > verB
   *  0 if verA = verB
   * -1 if verA < verB
   */
  async function compareChectlVersions(verA: string, verB: string): Promise<number> {
    if (verA === verB) {
      return 0
    }

    const verAChannel = verA.includes('next') ? 'next' : 'stable'
    const verBChannel = verB.includes('next') ? 'next' : 'stable'
    if (verAChannel !== verBChannel) {
      // Consider next is always newer
      return (verAChannel === 'next') ? 1 : -1
    }

    if (verAChannel === 'stable') {
      return semver.gt(verA, verB) ? 1 : -1
    }

    // Compare next versions, like: 0.0.20210715-next.597729a
    const verABase = verA.split('-')[0]
    const verBBase = verB.split('-')[0]
    if (verABase !== verBBase) {
      // Releases are made in different days
      // It is possible to compare just versions
      return semver.gt(verA, verB) ? 1 : -1
    }

    // Releases are made in the same day
    // It is not possible to compare by versions as the difference only in commits hashes
    const verACommitId = verA.split('-')[1].split('.')[1]
    const verBCommitId = verB.split('-')[1].split('.')[1]

    const githubClient = new CheGithubClient()
    const verACommitDateString = await githubClient.getCommitDate(ECLIPSE_CHE_INCUBATOR_ORG, CHECTL_REPO, verACommitId)
    const verBCommitDateString = await githubClient.getCommitDate(ECLIPSE_CHE_INCUBATOR_ORG, CHECTL_REPO, verBCommitId)
    const verATimestamp = Date.parse(verACommitDateString)
    const verBTimestamp = Date.parse(verBCommitDateString)
    return verATimestamp > verBTimestamp ? 1 : -1
  }

  /**
   * Indicates if stable version of Red Hat OpenShift Dev Spaces is specified or meant implicitly.
   */
  export function isDeployingStableVersion(_flags: any): boolean {
    return !ChectlContext.get().isDevVersion
  }

  /**
   * Removes 'v' prefix from version string.
   * @param version version to process
   * @param checkForNumber if true remove prefix only if a numeric version follow it (e.g. v7.x -> 7.x, vNext -> vNext)
   */
  export function removeVPrefix(version: string, checkForNumber = false): string {
    if (version.startsWith('v') && version.length > 1) {
      if (checkForNumber) {
        const char2 = version.charAt(1)
        if (char2 >= '0' && char2 <= '9') {
          return version.substr(1)
        }
      }
      return version.substr(1)
    }
    return version
  }

}

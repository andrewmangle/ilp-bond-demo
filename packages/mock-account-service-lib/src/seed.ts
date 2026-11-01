import { v4 } from 'uuid'
import { ApolloClient, NormalizedCacheObject } from '@apollo/client'
import createLogger, { LevelWithSilent, LoggerOptions } from 'pino'
import { generateJwk } from '@interledger/http-signature-utils'
import { createRequesters, createTenant } from './requesters'
import { Config } from './types'
import { Asset, FeeType, Tenant } from './generated/graphql'
import { AccountProvider } from './account-provider'

interface SetupFromSeedOptions {
  logLevel?: LevelWithSilent
  pinoPretty?: boolean
}

export async function setupFromSeed(
  config: Config,
  generateApolloClient: (options?: {
    tenantId: string
    apiSecret: string
  }) => ApolloClient<NormalizedCacheObject>,
  mockAccounts: AccountProvider,
  options: SetupFromSeedOptions = {}
): Promise<{ tenantId: string; apiSecret: string } | undefined> {
  const { logLevel = 'info', pinoPretty = false } = options

  const loggerOptions: LoggerOptions<never> = {
    level: logLevel
  }

  if (pinoPretty) {
    loggerOptions.transport = { target: 'pino-pretty' }
  }

  const apolloClient = generateApolloClient()

  const logger = createLogger(loggerOptions)

  let createdTenant: Tenant | undefined
  let requesterApolloClient: ApolloClient<NormalizedCacheObject> = apolloClient
  if (config.isTenant) {
    const seedTenant = config.seed.tenants[0]
    createdTenant = (
      await createTenant(
        apolloClient,
        seedTenant.publicName,
        seedTenant.apiSecret,
        seedTenant.idpConsentUrl,
        seedTenant.idpSecret,
        seedTenant.walletAddressPrefix,
        seedTenant.webhookUrl,
        seedTenant.id
      )
    ).tenant
    requesterApolloClient = generateApolloClient({
      tenantId: createdTenant.id,
      apiSecret: createdTenant.apiSecret
    })
  }

  const {
    createAsset,
    depositAssetLiquidity,
    setFee,
    createPeer,
    updatePeer,
    depositPeerLiquidity,
    createAutoPeer,
    createWalletAddress,
    createWalletAddressKey,
    getAssetByCodeAndScale,
    getWalletAddressByURL,
    getPeerByAddressAndAsset
  } = createRequesters(requesterApolloClient, logger)

  // Keyed by code for accounts (the first asset listed for a code), and by `code:scale` so the peering asset
  // can be a higher-precision version of an account asset (e.g. accounts in USD scale 2, peering in USD scale 9)
  const assets: Record<string, Asset> = {}
  for (const { code, scale, liquidity, liquidityThreshold } of config.seed
    .assets) {
    let asset = await getAssetByCodeAndScale(code, scale)
    if (!asset) {
      asset = (await createAsset(code, scale, liquidityThreshold)).asset || null
      if (!asset) {
        throw new Error(`Could not create asset: ${code}  ${scale}`)
      }
      await depositAssetLiquidity(asset.id, liquidity, v4())
    }

    assets[code] = assets[code] || asset
    assets[`${code}:${scale}`] = asset
    logger.debug({ asset, liquidity })

    const { fees } = config.seed
    const fee = fees.find((fee) => fee.asset === code && fee.scale == scale)
    if (fee) {
      await setFee(asset.id, FeeType.Sending, fee.fixed, fee.basisPoints)
    }
  }

  logger.debug('Finished seeding assets')

  // `USD` (the account asset for that code) or `USD:9` (that code at that scale)
  const peeringAsset = assets[config.seed.peeringAsset]
  if (!peeringAsset) {
    throw new Error(
      `Peering asset ${config.seed.peeringAsset} is not in the seed's assets`
    )
  }

  const host = config.isTenant
    ? config.seed.tenants[0].walletAddressPrefix
    : config.publicHost

  for (const peer of config.seed.peers) {
    let peerStaticIlpAddress
    // If peer needs to be unreachable, we need to use the staticIlpAddress without the `unreachable` segment in order to get the correct existing peer if any
    const isUnreachablePeer = peer.peerIlpAddress.includes('unreachable.')
    if (isUnreachablePeer) {
      peerStaticIlpAddress = peer.peerIlpAddress.replace('unreachable.', '')
    } else {
      peerStaticIlpAddress = peer.peerIlpAddress
    }

    // The lookup matches by destination address (routes/prefixes), so only accept an exact staticIlpAddress match
    const getExactPeer = async (address: string) => {
      const found = await getPeerByAddressAndAsset(address, peeringAsset.id)
      return found?.staticIlpAddress === address ? found : null
    }

    // An unreachable peer seeded on a previous run is stored under its full (`unreachable.`) address, so fall back to that
    const existingPeer =
      (await getExactPeer(peerStaticIlpAddress)) ??
      (isUnreachablePeer ? await getExactPeer(peer.peerIlpAddress) : null)

    if (existingPeer) {
      // Needed for refreshing routes and staticIlpAddress when changed in seed (when going back and forth from multihop mode)
      await updatePeer({
        id: existingPeer.id,
        staticIlpAddress: peer.peerIlpAddress,
        routes: peer.routes || []
      })
      continue
    }

    const newPeer = await createPeer(
      peer.peerIlpAddress,
      peer.peerUrl,
      peeringAsset.id,
      peer.name,
      peer.routes || [],
      peer.liquidityThreshold,
      peer.tokens.incoming,
      peer.tokens.outgoing,
      peer.maxPacketAmount
    ).then((response) => response.peer || null)

    if (!newPeer) {
      throw new Error('Could not create peer')
    }

    const transferUid = v4()
    await depositPeerLiquidity(newPeer.id, peer.initialLiquidity, transferUid)
  }

  logger.debug('Finished seeding peers')

  if (config.testnetAutoPeerUrl) {
    logger.debug('autopeering url: ', config.testnetAutoPeerUrl)
    const autoPeerResponse = await createAutoPeer(
      config.testnetAutoPeerUrl,
      peeringAsset.id
    ).catch((e) => {
      logger.debug('error on autopeering: ', e)
      return
    })
    logger.debug(autoPeerResponse)
  }

  // Clear the accounts before seeding, unless they were restored from storage: then keep them (and their
  // balances) and only add seeded accounts that are missing
  if (!mockAccounts.restored) {
    await mockAccounts.clearAccounts()
  }

  for (const account of config.seed.accounts) {
    const accountAsset = assets[account.assetCode]

    if (!accountAsset) {
      throw new Error(
        `Trying to create an account with a non-existing asset: ${account.assetCode}`
      )
    }

    if (!(mockAccounts.restored && (await mockAccounts.get(account.id)))) {
      await mockAccounts.create(
        account.id,
        account.path,
        account.name,
        accountAsset.code,
        accountAsset.scale,
        accountAsset.id
      )
      if (account.initialBalance) {
        await mockAccounts.credit(
          account.id,
          BigInt(account.initialBalance),
          false
        )
      }
    }

    if (account.skipWalletAddressCreation) {
      continue
    }

    const url = `${host}/${account.path}`
    let walletAddress = await getWalletAddressByURL(url)
    if (!walletAddress) {
      walletAddress = await createWalletAddress(
        account.name,
        url,
        accountAsset.id
      )

      await createWalletAddressKey({
        walletAddressId: walletAddress.id,
        jwk: generateJwk({
          keyId: `keyid-${account.id}`,
          privateKey: config.key
        }) as unknown as string
      })
    }

    await mockAccounts.setWalletAddress(
      account.id,
      walletAddress.id,
      walletAddress.address
    )
  }

  logger.debug('Finished seeding accounts/wallet addresses')
  logger.debug('Seed complete')

  const hostname = new URL(host).hostname
  const envVarStrings = config.seed.accounts.map((account) => {
    return `${account.brunoEnvVar}: ${host}/${account.path} hostname: ${hostname}`
  })
  logger.debug(envVarStrings)

  return createdTenant
    ? { tenantId: createdTenant.id, apiSecret: createdTenant.apiSecret }
    : undefined
}

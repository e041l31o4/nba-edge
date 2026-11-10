import { createContext, useContext } from 'react'

export type MembershipAccess = {
  authenticated: boolean
  active: boolean
  admin: boolean
  publicGameIds: string[]
}

export const MembershipAccessContext = createContext<MembershipAccess>({
  authenticated: false,
  active: false,
  admin: false,
  publicGameIds: [],
})

export const useMembershipAccess = () => useContext(MembershipAccessContext)

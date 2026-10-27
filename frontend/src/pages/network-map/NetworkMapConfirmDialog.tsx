import { ConfirmDialog, type ConfirmOptions } from '../../components/ConfirmDialog'

type Props = ConfirmOptions & {
  open: boolean
  onClose: () => void
  onConfirm: () => void
}

export function NetworkMapConfirmDialog(props: Props) {
  return <ConfirmDialog {...props} />
}

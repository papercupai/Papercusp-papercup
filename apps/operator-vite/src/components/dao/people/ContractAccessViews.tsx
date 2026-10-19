import { parseAsString, useQueryState } from 'nuqs';
import OnboardingViews from './OnboardingViews';
import EngagementViews from './EngagementViews';

/** The server authenticates each contract signer separately from DAO membership. */
export default function ContractAccessViews({daoSlug,onChanged}:{daoSlug:string;onChanged?:()=>void}) {
  const [offer,setOffer]=useQueryState('onboardingOffer', parseAsString.withDefault(''));
  return <section aria-label="My signed engagement"><h3>My signed engagement</h3>
    <p>Open the offer reference from your hiring administrator. Signer access remains available before admission and after leaving.</p>
    <form className="dao-form" aria-label="Open signed engagement" onSubmit={event=>{event.preventDefault();void setOffer(String(new FormData(event.currentTarget).get('offer')));}}>
      <label>Signed offer reference<input key={offer} name="offer" defaultValue={offer} required /></label><button type="submit">Open my engagement</button>
    </form>
    {offer?<><OnboardingViews key={'onboard:'+offer} daoSlug={daoSlug} offerId={offer} onChanged={onChanged} />
      <EngagementViews key={'engagement:'+offer} daoSlug={daoSlug} offerId={offer} onChanged={onChanged} /></>:null}
  </section>;
}

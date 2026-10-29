// Cognito pre-sign-up trigger.
// Accounts are created only server-side (AdminCreateUser) after Discord sign-in.
// Public SignUp and any federated first sign-in are rejected.
export const handler = async (event) => {
  if (event.triggerSource === 'PreSignUp_AdminCreateUser') return event;
  throw new Error('新規登録はDiscordから行ってください');
};

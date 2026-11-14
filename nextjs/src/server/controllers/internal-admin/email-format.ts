// EmailFormatValidator::EMAIL_REGEX (app/validators/email_format_validator.rb)
const EMAIL_REGEX = /^(?=.{3,255}$)(([^@\s()[\],.<>;:\\"]+(\.[^@\s()[\],.<>;:\\"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/u;

// EmailFormatValidator.valid?
export const emailFormatValid = (email: string | null | undefined): boolean => email !== undefined && email !== null && !/^\p{White_Space}*$/u.test(email) && EMAIL_REGEX.test(email);

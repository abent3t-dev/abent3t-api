import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

@ValidatorConstraint({ async: false })
class IsAfterConstraint implements ValidatorConstraintInterface {
  validate(value: any, args: ValidationArguments) {
    const [relatedField] = args.constraints;
    const relatedValue = (args.object as any)[relatedField];
    if (!value || !relatedValue) return true;
    return new Date(value) > new Date(relatedValue);
  }

  defaultMessage(args: ValidationArguments) {
    const [relatedField] = args.constraints;
    return `$property debe ser posterior a ${relatedField}`;
  }
}

export function IsAfter(
  property: string,
  validationOptions?: ValidationOptions,
) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      target: object.constructor,
      propertyName,
      constraints: [property],
      options: validationOptions,
      validator: IsAfterConstraint,
    });
  };
}
